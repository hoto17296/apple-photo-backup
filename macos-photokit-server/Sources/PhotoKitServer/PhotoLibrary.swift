import Foundation
@preconcurrency import Photos

/// Read-only access to the system photo library.
///
/// Everything is fetched from PhotoKit on each call; nothing is cached between requests.
enum PhotoLibrary {
    static var authorizationStatus: PHAuthorizationStatus {
        PHPhotoLibrary.authorizationStatus(for: .readWrite)
    }

    static func requestAuthorization() async -> PHAuthorizationStatus {
        await PHPhotoLibrary.requestAuthorization(for: .readWrite)
    }

    // MARK: - Library

    static func library() -> LibraryResponse {
        let status = authorizationStatus
        guard status.allowsReading else {
            return LibraryResponse(authorization: status.name, counts: nil, changeToken: nil)
        }
        return LibraryResponse(
            authorization: status.name,
            counts: .init(
                image: PHAsset.fetchAssets(with: .image, options: nil).count,
                video: PHAsset.fetchAssets(with: .video, options: nil).count,
                audio: PHAsset.fetchAssets(with: .audio, options: nil).count
            ),
            changeToken: try? ChangeToken.encode(PHPhotoLibrary.shared().currentChangeToken)
        )
    }

    // MARK: - Assets

    static func assets(query: AssetQuery, albumID: String? = nil) throws(APIError) -> Page<AssetResponse> {
        let options = query.fetchOptions()
        let result: PHFetchResult<PHAsset>
        if let albumID {
            result = PHAsset.fetchAssets(in: try album(id: albumID), options: options)
        } else {
            result = PHAsset.fetchAssets(with: options)
        }
        let (assets, next) = query.page(of: result)
        return Page(items: responses(for: assets), nextCursor: next?.encoded())
    }

    static func asset(id: String) throws(APIError) -> PHAsset {
        let options = PHFetchOptions()
        options.includeHiddenAssets = true
        options.includeAssetSourceTypes = .all
        guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: options).firstObject else {
            throw .notFound("Asset not found: \(id)")
        }
        return asset
    }

    static func response(for asset: PHAsset) -> AssetResponse {
        responses(for: [asset])[0]
    }

    private static func responses(for assets: [PHAsset]) -> [AssetResponse] {
        guard !assets.isEmpty else { return [] }
        let cloudIdentifiers = PHPhotoLibrary.shared().cloudIdentifierMappings(
            forLocalIdentifiers: assets.map(\.localIdentifier)
        )
        return assets.map { asset in
            let metadata = asset.extendedMetadata
            return AssetResponse(
                id: asset.localIdentifier,
                cloudIdentifier: try? cloudIdentifiers[asset.localIdentifier]?.get().archivalStringValue,
                mediaType: asset.mediaType.name,
                mediaSubtypes: asset.mediaSubtypes.names,
                playbackStyle: asset.playbackStyle.name,
                contentType: asset.contentType.identifier,
                pixelWidth: asset.pixelWidth,
                pixelHeight: asset.pixelHeight,
                duration: asset.mediaType == .video || asset.mediaType == .audio ? asset.duration : nil,
                createdAt: asset.creationDate,
                modifiedAt: asset.modificationDate,
                addedAt: asset.addedDate,
                location: asset.location.map {
                    .init(
                        latitude: $0.coordinate.latitude,
                        longitude: $0.coordinate.longitude,
                        altitude: $0.verticalAccuracy >= 0 ? $0.altitude : nil
                    )
                },
                isFavorite: asset.isFavorite,
                isHidden: asset.isHidden,
                rating: asset.rating == .unset ? nil : asset.rating.rawValue,
                caption: metadata.caption,
                keywords: metadata.keywords,
                originalFilename: metadata.originalFilename,
                burstIdentifier: asset.burstIdentifier,
                representsBurst: asset.representsBurst,
                sourceType: asset.sourceType.name,
                hasAdjustments: asset.hasAdjustments,
                adjustedAt: asset.adjustmentTimestamp
            )
        }
    }

    // MARK: - Resources

    static func resources(of asset: PHAsset) -> [PHAssetResource] {
        PHAssetResource.assetResources(for: asset)
    }

    static func resourceResponses(of asset: PHAsset) -> [ResourceResponse] {
        resources(of: asset).enumerated().map { index, resource in
            ResourceResponse(
                index: index,
                type: resource.type.name,
                filename: resource.filename,
                contentType: resource.contentType.identifier,
                mimeType: resource.contentType.preferredMIMEType,
                pixelWidth: resource.pixelWidth > 0 ? resource.pixelWidth : nil,
                pixelHeight: resource.pixelHeight > 0 ? resource.pixelHeight : nil,
                dataSize: resource.dataSize
            )
        }
    }

    /// The unedited file that best represents the asset.
    static func originalResource(of asset: PHAsset) -> PHAssetResource? {
        let resources = resources(of: asset)
        let preferred: [PHAssetResourceType] =
            switch asset.mediaType {
            case .image: asset.originalResourceChoice == .raw ? [.alternatePhoto, .photo] : [.photo, .alternatePhoto]
            case .video: [.video]
            case .audio: [.audio]
            default: []
            }
        for type in preferred {
            if let resource = resources.first(where: { $0.type == type }) {
                return resource
            }
        }
        return resources.first
    }

    /// The rendered file reflecting edits made in Photos, if the library has one.
    static func renderedResource(of asset: PHAsset) -> PHAssetResource? {
        let type: PHAssetResourceType = asset.mediaType == .video ? .fullSizeVideo : .fullSizePhoto
        return resources(of: asset).first { $0.type == type }
    }

    // MARK: - Albums

    enum AlbumType: String, CaseIterable, Sendable {
        case user, smart, shared
    }

    static func albums(types: Set<AlbumType>) -> [AlbumResponse] {
        var collections: [PHAssetCollection] = []
        if !types.isDisjoint(with: [.user, .shared]) {
            PHAssetCollection.fetchAssetCollections(with: .album, subtype: .any, options: nil)
                .enumerateObjects { collection, _, _ in
                    if types.contains(albumType(of: collection)) {
                        collections.append(collection)
                    }
                }
        }
        if types.contains(.smart) {
            PHAssetCollection.fetchAssetCollections(with: .smartAlbum, subtype: .any, options: nil)
                .enumerateObjects { collection, _, _ in collections.append(collection) }
        }
        let folderPaths = types.contains(.user) ? folderPathsOfUserAlbums() : [:]
        return collections.map { response(for: $0, folderPaths: folderPaths) }
    }

    static func album(id: String) throws(APIError) -> PHAssetCollection {
        guard let album = PHAssetCollection.fetchAssetCollections(withLocalIdentifiers: [id], options: nil).firstObject
        else {
            throw .notFound("Album not found: \(id)")
        }
        return album
    }

    static func albumResponse(id: String) throws(APIError) -> AlbumResponse {
        let album = try album(id: id)
        let folderPaths = albumType(of: album) == .user ? folderPathsOfUserAlbums() : [:]
        return response(for: album, folderPaths: folderPaths)
    }

    private static func albumType(of collection: PHAssetCollection) -> AlbumType {
        switch collection.assetCollectionType {
        case .smartAlbum: .smart
        default: collection.assetCollectionSubtype == .albumCloudShared ? .shared : .user
        }
    }

    private static func response(for collection: PHAssetCollection, folderPaths: [String: [String]]) -> AlbumResponse {
        AlbumResponse(
            id: collection.localIdentifier,
            title: collection.localizedTitle,
            type: albumType(of: collection).rawValue,
            subtype: collection.assetCollectionSubtype.name,
            folderPath: folderPaths[collection.localIdentifier] ?? [],
            assetCount: PHAsset.fetchAssets(in: collection, options: nil).count,
            startDate: collection.startDate,
            endDate: collection.endDate
        )
    }

    /// Maps each user album inside folders to the titles of its enclosing folders.
    private static func folderPathsOfUserAlbums() -> [String: [String]] {
        var paths: [String: [String]] = [:]
        func walk(_ result: PHFetchResult<PHCollection>, path: [String]) {
            result.enumerateObjects { collection, _, _ in
                if let list = collection as? PHCollectionList {
                    walk(PHCollection.fetchCollections(in: list, options: nil), path: path + [list.localizedTitle ?? ""])
                } else if !path.isEmpty {
                    paths[collection.localIdentifier] = path
                }
            }
        }
        walk(PHCollectionList.fetchTopLevelUserCollections(with: nil), path: [])
        return paths
    }

    // MARK: - Changes

    static func changes(since encodedToken: String?) throws(APIError) -> ChangesResponse {
        let library = PHPhotoLibrary.shared()
        guard let encodedToken else {
            return ChangesResponse(token: try ChangeToken.encode(library.currentChangeToken), assets: .init(), albums: .init())
        }
        let token = try ChangeToken.decode(encodedToken)

        let changes: PHPersistentChangeFetchResult
        do {
            changes = try library.fetchPersistentChanges(since: token)
        } catch let error as NSError where error.domain == PHPhotosErrorDomain && error.code == PHPhotosError.persistentChangeTokenExpired.rawValue {
            throw .changeTokenExpired
        } catch {
            throw .internalError("Failed to fetch changes: \(error.localizedDescription)")
        }

        var assets = ChangeAccumulator()
        var albums = ChangeAccumulator()
        var latest = token
        do {
            for change in changes {
                try assets.apply(change.changeDetails(for: .asset))
                try albums.apply(change.changeDetails(for: .assetCollection))
                latest = change.changeToken
            }
        } catch {
            throw .internalError("Failed to read changes: \(error.localizedDescription)")
        }
        return ChangesResponse(token: try ChangeToken.encode(latest), assets: assets.details, albums: albums.details)
    }
}

/// Folds a sequence of persistent changes into net inserted / updated / deleted identifiers.
struct ChangeAccumulator {
    private var inserted: Set<String> = []
    private var updated: Set<String> = []
    private var deleted: Set<String> = []

    mutating func apply(_ details: PHPersistentObjectChangeDetails) {
        apply(
            inserted: details.insertedLocalIdentifiers,
            updated: details.updatedLocalIdentifiers,
            deleted: details.deletedLocalIdentifiers
        )
    }

    mutating func apply(inserted newInserted: Set<String>, updated newUpdated: Set<String>, deleted newDeleted: Set<String>) {
        for id in newInserted {
            deleted.remove(id)
            inserted.insert(id)
        }
        for id in newUpdated where !inserted.contains(id) {
            updated.insert(id)
        }
        for id in newDeleted {
            updated.remove(id)
            // Inserted and then deleted within the range: the client never saw it.
            if inserted.remove(id) == nil {
                deleted.insert(id)
            }
        }
    }

    var details: ChangesResponse.Details {
        .init(inserted: inserted.sorted(), updated: updated.sorted(), deleted: deleted.sorted())
    }
}

enum ChangeToken {
    static func encode(_ token: PHPersistentChangeToken) throws(APIError) -> String {
        do {
            return try NSKeyedArchiver.archivedData(withRootObject: token, requiringSecureCoding: true)
                .base64URLEncodedString()
        } catch {
            throw .internalError("Failed to encode change token: \(error.localizedDescription)")
        }
    }

    static func decode(_ string: String) throws(APIError) -> PHPersistentChangeToken {
        guard let data = Data(base64URLEncoded: string),
            let token = try? NSKeyedUnarchiver.unarchivedObject(ofClass: PHPersistentChangeToken.self, from: data)
        else {
            throw .badRequest("Invalid change token")
        }
        return token
    }
}
