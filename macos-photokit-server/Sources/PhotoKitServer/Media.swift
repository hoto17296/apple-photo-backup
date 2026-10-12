import AVFoundation
import AppKit
import Foundation
import Hummingbird
import ImageIO
import Logging
@preconcurrency import Photos
import UniformTypeIdentifiers

/// Loads asset files from PhotoKit and turns them into HTTP responses.
struct Media: Sendable {
    let limiter: ConcurrencyLimiter
    let timeout: Duration
    let temporaryDirectory: URL
    let logger: Logger

    init(configuration: ServerConfiguration, logger: Logger = Logger(label: "photokit-server")) {
        self.logger = logger
        limiter = ConcurrencyLimiter(limit: configuration.maxConcurrentDownloads)
        timeout = .seconds(configuration.downloadTimeout)
        temporaryDirectory = FileManager.default.temporaryDirectory.appending(path: "photokit-server", directoryHint: .isDirectory)
    }

    /// Removes temporary files left behind by a previous run.
    func prepareTemporaryDirectory() throws {
        try? FileManager.default.removeItem(at: temporaryDirectory)
        try FileManager.default.createDirectory(at: temporaryDirectory, withIntermediateDirectories: true)
    }

    // MARK: - Resource files

    /// Responds with the bytes of an asset resource, downloading it from iCloud if allowed.
    ///
    /// The resource is first written to a temporary file so errors can be reported with a proper
    /// status code and `Range` requests can be served. The file is unlinked as soon as it is opened.
    func resourceResponse(_ resource: PHAssetResource, request: Request, networkAccessAllowed: Bool) async throws -> Response {
        let url = temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: url) }
        try await limiter.run {
            try await write(resource, to: url, networkAccessAllowed: networkAccessAllowed)
        }
        return try fileResponse(
            url: url,
            request: request,
            contentType: resource.contentType,
            filename: resource.filename
        )
    }

    private func write(_ resource: PHAssetResource, to url: URL, networkAccessAllowed: Bool) async throws {
        guard FileManager.default.createFile(atPath: url.path, contents: nil) else {
            throw APIError.internalError("Failed to create a temporary file")
        }
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }

        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = networkAccessAllowed
        let manager = PHAssetResourceManager.default()
        let state = RequestState<Void, PHAssetResourceDataRequestID>()

        try await withPhotosRequest(state: state, cancel: { manager.cancelDataRequest($0) }) {
            // Handlers are called serially on a PhotoKit queue.
            let writeError = WriteError()
            return manager.requestData(
                for: resource, options: options,
                dataReceivedHandler: { data in
                    do {
                        try handle.write(contentsOf: data)
                    } catch {
                        writeError.error = error
                    }
                },
                completionHandler: { error in
                    if let error = error ?? writeError.error {
                        state.finish(.failure(Self.apiError(error)))
                    } else {
                        state.finish(.success(()))
                    }
                }
            )
        }
    }

    private func resourceData(_ resource: PHAssetResource, networkAccessAllowed: Bool) async throws -> Data {
        let url = temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: url) }
        try await write(resource, to: url, networkAccessAllowed: networkAccessAllowed)
        return try Data(contentsOf: url)
    }

    // MARK: - Rendered images

    /// Responds with the current (edited) version of an image rendered by PhotoKit.
    func renderedImageResponse(_ asset: PHAsset, request: Request, networkAccessAllowed: Bool) async throws -> Response {
        let (data, uti) = try await limiter.run {
            try await renderedImageData(asset, networkAccessAllowed: networkAccessAllowed)
        }
        let url = temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: url) }
        try data.write(to: url)
        return try fileResponse(url: url, request: request, contentType: uti.flatMap(UTType.init) ?? .data, filename: nil)
    }

    private func renderedImageData(_ asset: PHAsset, networkAccessAllowed: Bool) async throws -> (Data, String?) {
        let options = PHImageRequestOptions()
        options.version = .current
        options.deliveryMode = .highQualityFormat
        options.isNetworkAccessAllowed = networkAccessAllowed
        let manager = PHImageManager.default()
        let state = RequestState<(Data, String?), PHImageRequestID>()

        return try await withPhotosRequest(state: state, cancel: { manager.cancelImageRequest($0) }) {
            manager.requestImageDataAndOrientation(for: asset, options: options) { data, uti, _, info in
                if let data {
                    state.finish(.success((data, uti)))
                } else {
                    state.finish(.failure(Self.imageError(info)))
                }
            }
        }
    }

    // MARK: - Rendered videos

    /// Responds with the current (edited) version of a video, exported by PhotoKit.
    ///
    /// Used only when the library has no rendered video file for an edited video. The edits have to
    /// be re-encoded, so this takes time proportional to the length of the video.
    func renderedVideoResponse(_ asset: PHAsset, request: Request, networkAccessAllowed: Bool) async throws -> Response {
        let url = temporaryDirectory.appending(path: UUID().uuidString + ".mov")
        defer { try? FileManager.default.removeItem(at: url) }
        try await limiter.run {
            let session = try await exportSession(asset, networkAccessAllowed: networkAccessAllowed)
            try await withThrowingTaskGroup { group in
                group.addTask { try await session.value.export(to: url, as: .mov) }
                group.addTask {
                    try await Task.sleep(for: timeout)
                    throw APIError.timeout
                }
                defer { group.cancelAll() }
                try await group.next()
            }
        }
        return try fileResponse(url: url, request: request, contentType: .quickTimeMovie, filename: nil)
    }

    private func exportSession(_ asset: PHAsset, networkAccessAllowed: Bool) async throws -> UncheckedSendable<AVAssetExportSession> {
        let options = PHVideoRequestOptions()
        options.version = .current
        options.deliveryMode = .highQualityFormat
        options.isNetworkAccessAllowed = networkAccessAllowed
        let manager = PHImageManager.default()
        let state = RequestState<UncheckedSendable<AVAssetExportSession>, PHImageRequestID>()

        return try await withPhotosRequest(state: state, cancel: { manager.cancelImageRequest($0) }) {
            manager.requestExportSession(
                forVideo: asset, options: options, exportPreset: AVAssetExportPresetHEVCHighestQuality
            ) { session, info in
                if let session {
                    state.finish(.success(UncheckedSendable(value: session)))
                } else {
                    state.finish(.failure(Self.imageError(info)))
                }
            }
        }
    }

    // MARK: - Thumbnails

    enum ThumbnailFormat: String, Sendable {
        case jpeg, heic, png

        var type: UTType {
            switch self {
            case .jpeg: .jpeg
            case .heic: .heic
            case .png: .png
            }
        }
    }

    /// Responds with an image scaled to fit within `size` x `size` pixels.
    func thumbnailResponse(
        _ asset: PHAsset, size: Int, format: ThumbnailFormat, quality: Double, networkAccessAllowed: Bool
    ) async throws -> Response {
        let image = try await limiter.run {
            do {
                return try await thumbnailImage(asset, size: size, networkAccessAllowed: networkAccessAllowed)
            } catch is ImageUnavailable {
                // PHImageManager.requestImage sometimes returns no image without any error.
                // Fall back to loading the full image (or video) and scaling it here.
                logger.notice("requestImage returned no image for \(asset.localIdentifier); scaling it on the server instead")
                return try await scaledImage(asset, size: size, networkAccessAllowed: networkAccessAllowed)
            }
        }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, format.type.identifier as CFString, 1, nil) else {
            throw APIError.internalError("Unsupported thumbnail format: \(format.rawValue)")
        }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else {
            throw APIError.internalError("Failed to encode the thumbnail")
        }
        return Response(
            status: .ok,
            headers: [.contentType: format.type.preferredMIMEType ?? "application/octet-stream"],
            body: .init(byteBuffer: ByteBuffer(bytes: data as Data))
        )
    }

    private func thumbnailImage(_ asset: PHAsset, size: Int, networkAccessAllowed: Bool) async throws -> CGImage {
        let options = PHImageRequestOptions()
        options.deliveryMode = .highQualityFormat
        options.resizeMode = .exact
        options.isNetworkAccessAllowed = networkAccessAllowed
        let manager = PHImageManager.default()
        let state = RequestState<CGImage, PHImageRequestID>()

        return try await withPhotosRequest(state: state, cancel: { manager.cancelImageRequest($0) }) {
            manager.requestImage(
                for: asset,
                targetSize: CGSize(width: size, height: size),
                contentMode: .aspectFit,
                options: options
            ) { image, info in
                if (info?[PHImageResultIsDegradedKey] as? Bool) == true {
                    return
                }
                if let image {
                    if let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) {
                        state.finish(.success(cgImage))
                    } else {
                        state.finish(.failure(APIError.internalError("Failed to convert the image (size: \(image.size))")))
                    }
                } else if info?[PHImageErrorKey] == nil, (info?[PHImageResultIsInCloudKey] as? Bool) != true {
                    state.finish(.failure(ImageUnavailable()))
                } else {
                    state.finish(.failure(Self.imageError(info)))
                }
            }
        }
    }

    /// Loads the current version of the asset in full and scales it to fit within `size` x `size` pixels.
    private func scaledImage(_ asset: PHAsset, size: Int, networkAccessAllowed: Bool) async throws -> CGImage {
        switch asset.mediaType {
        case .image:
            let data: Data
            do {
                (data, _) = try await renderedImageData(asset, networkAccessAllowed: networkAccessAllowed)
            } catch let error as APIError where error.status == .internalServerError {
                // Last resort: the original file, which loses edits but is read the same way as /original.
                guard let resource = PhotoLibrary.originalResource(of: asset) else { throw error }
                logger.notice("Could not render \(asset.localIdentifier) (\(error.message)); using the original file")
                data = try await resourceData(resource, networkAccessAllowed: networkAccessAllowed)
            }
            guard let source = CGImageSourceCreateWithData(data as CFData, nil) else {
                throw APIError.internalError("Failed to decode the image")
            }
            let options: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: size,
            ]
            guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
                throw APIError.internalError("Failed to scale the image")
            }
            return image
        case .video:
            let video = try await videoAsset(asset, networkAccessAllowed: networkAccessAllowed)
            let generator = AVAssetImageGenerator(asset: video.value)
            generator.appliesPreferredTrackTransform = true
            generator.maximumSize = CGSize(width: size, height: size)
            do {
                return try await generator.image(at: .zero).image
            } catch {
                throw APIError.internalError("Failed to get a frame of the video: \(error.localizedDescription)")
            }
        default:
            throw APIError.notFound("The asset has no image")
        }
    }

    private func videoAsset(_ asset: PHAsset, networkAccessAllowed: Bool) async throws -> UncheckedSendable<AVAsset> {
        let options = PHVideoRequestOptions()
        options.version = .current
        options.deliveryMode = .highQualityFormat
        options.isNetworkAccessAllowed = networkAccessAllowed
        let manager = PHImageManager.default()
        let state = RequestState<UncheckedSendable<AVAsset>, PHImageRequestID>()

        return try await withPhotosRequest(state: state, cancel: { manager.cancelImageRequest($0) }) {
            manager.requestAVAsset(forVideo: asset, options: options) { video, _, info in
                if let video {
                    state.finish(.success(UncheckedSendable(value: video)))
                } else {
                    state.finish(.failure(Self.imageError(info)))
                }
            }
        }
    }

    // MARK: - Helpers

    /// Runs a callback-based PhotoKit request, cancelling it on timeout or task cancellation.
    private func withPhotosRequest<Value: Sendable, ID: Sendable>(
        state: RequestState<Value, ID>,
        cancel: @escaping @Sendable (ID) -> Void,
        start: () -> ID
    ) async throws -> Value {
        let timeout = timeout
        let timer = Task {
            try await Task.sleep(for: timeout)
            state.finish(.failure(APIError.timeout))
        }
        defer { timer.cancel() }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                state.start(continuation: continuation, id: start(), cancel: cancel)
            }
        } onCancel: {
            state.finish(.failure(CancellationError()))
        }
    }

    private static func apiError(_ error: Error) -> Error {
        let error = error as NSError
        if error.domain == PHPhotosErrorDomain && error.code == PHPhotosError.networkAccessRequired.rawValue {
            return APIError.networkAccessRequired
        }
        return APIError.internalError("Failed to load the resource: \(error.localizedDescription)")
    }

    private static func imageError(_ info: [AnyHashable: Any]?) -> Error {
        if let error = info?[PHImageErrorKey] as? Error {
            return apiError(error)
        }
        if (info?[PHImageResultIsInCloudKey] as? Bool) == true {
            return APIError.networkAccessRequired
        }
        let details = (info ?? [:]).map { "\($0.key)=\($0.value)" }.sorted().joined(separator: ", ")
        return APIError.internalError("Failed to load the image (\(details))")
    }

    /// Builds a response streaming a file, honoring a single-range `Range` header.
    private func fileResponse(url: URL, request: Request, contentType: UTType, filename: String?) throws -> Response {
        let handle = try FileHandle(forReadingFrom: url)
        // The open handle keeps the data readable; the path is no longer needed.
        try? FileManager.default.removeItem(at: url)
        let size = Int(try handle.seekToEnd())

        var headers: HTTPFields = [
            .contentType: contentType.preferredMIMEType ?? "application/octet-stream",
            .acceptRanges: "bytes",
        ]
        if let filename {
            headers[.contentDisposition] = Self.contentDisposition(filename: filename)
        }

        var status = HTTPResponse.Status.ok
        var range = 0..<size
        if let header = request.headers[.range] {
            guard let requested = ByteRange(header: header, size: size) else {
                try? handle.close()
                headers[.contentRange] = "bytes */\(size)"
                return Response(status: .rangeNotSatisfiable, headers: headers)
            }
            status = .partialContent
            range = requested.range
            headers[.contentRange] = "bytes \(range.lowerBound)-\(range.upperBound - 1)/\(size)"
        }

        let body = ResponseBody(contentLength: range.count) { [range] writer in
            defer { try? handle.close() }
            try handle.seek(toOffset: UInt64(range.lowerBound))
            var remaining = range.count
            while remaining > 0 {
                guard let chunk = try handle.read(upToCount: min(remaining, 1 << 20)), !chunk.isEmpty else { break }
                try await writer.write(ByteBuffer(bytes: chunk))
                remaining -= chunk.count
            }
            try await writer.finish(nil)
        }
        return Response(status: status, headers: headers, body: body)
    }

    private static func contentDisposition(filename: String) -> String {
        let ascii = String(filename.unicodeScalars.map { $0.isASCII && $0 != "\"" && $0 != "\\" ? Character($0) : "_" })
        let encoded = filename.addingPercentEncoding(withAllowedCharacters: .urlUnreservedCharacters) ?? ascii
        return "inline; filename=\"\(ascii)\"; filename*=UTF-8''\(encoded)"
    }
}

/// A single byte range parsed from a `Range` header (`bytes=a-b`, `bytes=a-`, `bytes=-n`).
struct ByteRange: Equatable {
    let range: Range<Int>

    init?(header: String, size: Int) {
        guard header.hasPrefix("bytes="), size > 0 else { return nil }
        let spec = header.dropFirst("bytes=".count)
        guard !spec.contains(","), let dash = spec.firstIndex(of: "-") else { return nil }
        let start = spec[..<dash].trimmingCharacters(in: .whitespaces)
        let end = spec[spec.index(after: dash)...].trimmingCharacters(in: .whitespaces)
        switch (Int(start), Int(end)) {
        case (let start?, let end?) where start <= end && start < size:
            range = start..<min(end + 1, size)
        case (let start?, nil) where end.isEmpty && start < size:
            range = start..<size
        case (nil, let suffix?) where start.isEmpty && suffix > 0:
            range = max(size - suffix, 0)..<size
        default:
            return nil
        }
    }
}

/// Bridges a callback-based PhotoKit request to a continuation, resuming it exactly once.
private final class RequestState<Value: Sendable, ID: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Value, Error>?
    private var pending: Result<Value, Error>?
    private var request: (id: ID, cancel: @Sendable (ID) -> Void)?
    private var finished = false

    func start(continuation: CheckedContinuation<Value, Error>, id: ID, cancel: @escaping @Sendable (ID) -> Void) {
        lock.lock()
        if let pending {
            // Finished (or cancelled / timed out) before the request was registered.
            lock.unlock()
            if case .failure = pending { cancel(id) }
            continuation.resume(with: pending)
            return
        }
        self.continuation = continuation
        self.request = (id, cancel)
        lock.unlock()
    }

    func finish(_ result: Result<Value, Error>) {
        lock.lock()
        guard !finished else {
            lock.unlock()
            return
        }
        finished = true
        guard let continuation else {
            pending = result
            lock.unlock()
            return
        }
        let request = request
        self.continuation = nil
        lock.unlock()
        if case .failure = result, let request {
            request.cancel(request.id)
        }
        continuation.resume(with: result)
    }
}

/// `PHImageManager.requestImage` finished without an image and without an error.
private struct ImageUnavailable: Error {}

private final class WriteError: @unchecked Sendable {
    var error: Error?
}

/// Carries a non-Sendable PhotoKit / AVFoundation object that is only used by one task at a time.
private struct UncheckedSendable<Value>: @unchecked Sendable {
    let value: Value
}

/// Limits how many PhotoKit loads run at the same time.
actor ConcurrencyLimiter {
    private let limit: Int
    private var running = 0
    private var waiters: [CheckedContinuation<Void, Never>] = []

    init(limit: Int) {
        self.limit = max(limit, 1)
    }

    func run<T: Sendable>(_ operation: @Sendable () async throws -> T) async throws -> T {
        await acquire()
        defer { release() }
        return try await operation()
    }

    private func acquire() async {
        if running < limit {
            running += 1
            return
        }
        await withCheckedContinuation { waiters.append($0) }
    }

    private func release() {
        if waiters.isEmpty {
            running -= 1
        } else {
            waiters.removeFirst().resume()
        }
    }
}

extension CharacterSet {
    static let urlUnreservedCharacters = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
}
