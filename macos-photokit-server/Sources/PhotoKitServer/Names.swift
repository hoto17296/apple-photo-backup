@preconcurrency import Photos

// String representations of PhotoKit enums used in the API.

extension PHAuthorizationStatus {
    var name: String {
        switch self {
        case .notDetermined: "not_determined"
        case .restricted: "restricted"
        case .denied: "denied"
        case .authorized: "authorized"
        case .limited: "limited"
        @unknown default: "unknown"
        }
    }

    var allowsReading: Bool {
        self == .authorized || self == .limited
    }
}

extension PHAssetMediaType {
    var name: String {
        switch self {
        case .image: "image"
        case .video: "video"
        case .audio: "audio"
        case .unknown: "unknown"
        @unknown default: "unknown"
        }
    }

    init?(name: String) {
        switch name {
        case "image": self = .image
        case "video": self = .video
        case "audio": self = .audio
        default: return nil
        }
    }
}

extension PHAssetMediaSubtype {
    static let names: [(String, PHAssetMediaSubtype)] = [
        ("panorama", .photoPanorama),
        ("hdr", .photoHDR),
        ("screenshot", .photoScreenshot),
        ("live_photo", .photoLive),
        ("depth_effect", .photoDepthEffect),
        ("animation", .photoAnimation),
        ("spatial", .spatialMedia),
        ("streamed", .videoStreamed),
        ("high_frame_rate", .videoHighFrameRate),
        ("timelapse", .videoTimelapse),
        ("screen_recording", .videoScreenRecording),
        ("cinematic", .videoCinematic),
    ]

    var names: [String] {
        Self.names.filter { contains($0.1) }.map(\.0)
    }

    init?(name: String) {
        guard let value = Self.names.first(where: { $0.0 == name })?.1 else { return nil }
        self = value
    }
}

extension PHAsset.PlaybackStyle {
    var name: String {
        switch self {
        case .unsupported: "unsupported"
        case .image: "image"
        case .imageAnimated: "image_animated"
        case .livePhoto: "live_photo"
        case .video: "video"
        case .videoLooping: "video_looping"
        @unknown default: "unknown"
        }
    }
}

extension PHAssetSourceType {
    var name: String {
        if contains(.typeCloudShared) { return "cloud_shared" }
        if contains(.typeiTunesSynced) { return "itunes_synced" }
        if contains(.typeUserLibrary) { return "user_library" }
        return "unknown"
    }

    static let all: PHAssetSourceType = [.typeUserLibrary, .typeCloudShared, .typeiTunesSynced]
}

extension PHAssetResourceType {
    var name: String {
        switch self {
        case .photo: "photo"
        case .video: "video"
        case .audio: "audio"
        case .alternatePhoto: "alternate_photo"
        case .fullSizePhoto: "full_size_photo"
        case .fullSizeVideo: "full_size_video"
        case .adjustmentData: "adjustment_data"
        case .adjustmentBasePhoto: "adjustment_base_photo"
        case .pairedVideo: "paired_video"
        case .fullSizePairedVideo: "full_size_paired_video"
        case .adjustmentBasePairedVideo: "adjustment_base_paired_video"
        case .adjustmentBaseVideo: "adjustment_base_video"
        case .photoProxy: "photo_proxy"
        @unknown default: "unknown_\(rawValue)"
        }
    }
}

extension PHAssetCollectionSubtype {
    var name: String {
        switch self {
        case .albumRegular: "regular"
        case .albumSyncedEvent: "synced_event"
        case .albumSyncedFaces: "synced_faces"
        case .albumSyncedAlbum: "synced_album"
        case .albumImported: "imported"
        case .albumMyPhotoStream: "my_photo_stream"
        case .albumCloudShared: "cloud_shared"
        case .smartAlbumGeneric: "generic"
        case .smartAlbumPanoramas: "panoramas"
        case .smartAlbumVideos: "videos"
        case .smartAlbumFavorites: "favorites"
        case .smartAlbumTimelapses: "timelapses"
        case .smartAlbumAllHidden: "all_hidden"
        case .smartAlbumRecentlyAdded: "recently_added"
        case .smartAlbumBursts: "bursts"
        case .smartAlbumSlomoVideos: "slomo_videos"
        case .smartAlbumUserLibrary: "user_library"
        case .smartAlbumSelfPortraits: "self_portraits"
        case .smartAlbumScreenshots: "screenshots"
        case .smartAlbumDepthEffect: "depth_effect"
        case .smartAlbumLivePhotos: "live_photos"
        case .smartAlbumAnimated: "animated"
        case .smartAlbumLongExposures: "long_exposures"
        case .smartAlbumUnableToUpload: "unable_to_upload"
        case .smartAlbumRAW: "raw"
        case .smartAlbumCinematic: "cinematic"
        case .smartAlbumSpatial: "spatial"
        case .smartAlbumScreenRecordings: "screen_recordings"
        default: "unknown_\(rawValue)"
        }
    }
}
