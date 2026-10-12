import Foundation
import Hummingbird
@preconcurrency import Photos

func buildRouter(configuration: ServerConfiguration, media: Media) -> Router<BasicRequestContext> {
    let router = Router()
    router.add(middleware: RequestLogMiddleware())
    if let token = configuration.token {
        router.add(middleware: BearerTokenMiddleware(token: token))
    }
    router.add(middleware: PhotosAuthorizationMiddleware())

    @Sendable func networkAccessAllowed(_ request: Request) throws -> Bool {
        guard let value = request.uri.queryParameters["network"] else { return configuration.allowNetworkAccess }
        switch value {
        case "true", "1": return true
        case "false", "0": return false
        default: throw APIError.badRequest("network must be true or false")
        }
    }

    router.get("/health") { _, _ in
        try JSON.response(["status": "ok"])
    }

    router.get("/openapi.json") { _, _ in
        Response(
            status: .ok,
            headers: [.contentType: "application/json; charset=utf-8"],
            body: .init(byteBuffer: ByteBuffer(bytes: PackageResources.openapi_json))
        )
    }

    router.get("/library") { _, _ in
        try JSON.response(PhotoLibrary.library())
    }

    // MARK: Assets

    router.get("/assets") { request, _ in
        let query = try AssetQuery(parameters: request.uri.queryParameters)
        return try JSON.response(PhotoLibrary.assets(query: query))
    }

    router.get("/assets/:id") { _, context in
        let asset = try PhotoLibrary.asset(id: try context.decodedParameter("id"))
        return try JSON.response(PhotoLibrary.response(for: asset))
    }

    router.get("/assets/:id/resources") { _, context in
        let asset = try PhotoLibrary.asset(id: try context.decodedParameter("id"))
        return try JSON.response(PhotoLibrary.resourceResponses(of: asset))
    }

    router.get("/assets/:id/resources/:index") { request, context in
        let asset = try PhotoLibrary.asset(id: try context.decodedParameter("id"))
        let resources = PhotoLibrary.resources(of: asset)
        guard let index = context.parameters.get("index", as: Int.self), resources.indices.contains(index) else {
            throw APIError.notFound("Resource not found")
        }
        return try await media.resourceResponse(
            resources[index], request: request, networkAccessAllowed: try networkAccessAllowed(request)
        )
    }

    router.get("/assets/:id/original") { request, context in
        let asset = try PhotoLibrary.asset(id: try context.decodedParameter("id"))
        guard let resource = PhotoLibrary.originalResource(of: asset) else {
            throw APIError.notFound("The asset has no original resource")
        }
        return try await media.resourceResponse(
            resource, request: request, networkAccessAllowed: try networkAccessAllowed(request)
        )
    }

    router.get("/assets/:id/rendered") { request, context in
        let asset = try PhotoLibrary.asset(id: try context.decodedParameter("id"))
        let network = try networkAccessAllowed(request)
        if let resource = PhotoLibrary.renderedResource(of: asset) {
            return try await media.resourceResponse(resource, request: request, networkAccessAllowed: network)
        }
        if asset.hasAdjustments {
            // Edited, but the library has no rendered file: let PhotoKit render it.
            switch asset.mediaType {
            case .image:
                return try await media.renderedImageResponse(asset, request: request, networkAccessAllowed: network)
            case .video:
                return try await media.renderedVideoResponse(asset, request: request, networkAccessAllowed: network)
            default:
                break
            }
        }
        // Not edited: the original is the current version.
        guard let resource = PhotoLibrary.originalResource(of: asset) else {
            throw APIError.notFound("The asset has no resource")
        }
        return try await media.resourceResponse(resource, request: request, networkAccessAllowed: network)
    }

    router.get("/assets/:id/thumbnail") { request, context in
        let asset = try PhotoLibrary.asset(id: try context.decodedParameter("id"))
        let parameters = request.uri.queryParameters
        let size = parameters["size"].map { Int($0) } ?? 512
        guard let size, (16...4096).contains(size) else {
            throw APIError.badRequest("size must be an integer between 16 and 4096")
        }
        let format = parameters["format"].map { Media.ThumbnailFormat(rawValue: String($0)) } ?? .jpeg
        guard let format else {
            throw APIError.badRequest("format must be one of jpeg, heic, png")
        }
        let quality = parameters["quality"].map { Double($0) } ?? 0.8
        guard let quality, (0...1).contains(quality) else {
            throw APIError.badRequest("quality must be a number between 0 and 1")
        }
        return try await media.thumbnailResponse(
            asset, size: size, format: format, quality: quality, networkAccessAllowed: try networkAccessAllowed(request)
        )
    }

    // MARK: Albums

    router.get("/albums") { request, _ in
        var types = Set(PhotoLibrary.AlbumType.allCases)
        if let value = request.uri.queryParameters["type"] {
            types = []
            for name in value.split(separator: ",") {
                guard let type = PhotoLibrary.AlbumType(rawValue: String(name)) else {
                    throw APIError.badRequest("type must be a comma separated list of user, smart, shared")
                }
                types.insert(type)
            }
        }
        return try JSON.response(PhotoLibrary.albums(types: types))
    }

    router.get("/albums/:id") { _, context in
        try JSON.response(PhotoLibrary.albumResponse(id: try context.decodedParameter("id")))
    }

    router.get("/albums/:id/assets") { request, context in
        let query = try AssetQuery(parameters: request.uri.queryParameters)
        return try JSON.response(PhotoLibrary.assets(query: query, albumID: try context.decodedParameter("id")))
    }

    // MARK: Changes

    router.get("/changes") { request, _ in
        try JSON.response(PhotoLibrary.changes(since: request.uri.queryParameters["since"].map(String.init)))
    }

    return router
}

extension RequestContext {
    /// A path parameter with percent-encoding removed (local identifiers contain `/`, sent as `%2F`).
    func decodedParameter(_ name: String) throws -> String {
        guard let value = parameters.get(name), let decoded = value.removingPercentEncoding else {
            throw APIError.badRequest("Invalid \(name)")
        }
        return decoded
    }
}
