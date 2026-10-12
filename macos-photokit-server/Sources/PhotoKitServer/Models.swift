import Foundation

// JSON response bodies. Property names are converted to snake_case on encoding,
// and nil properties are omitted.

struct Page<Item: Encodable>: Encodable {
    let items: [Item]
    /// Pass as `cursor` to fetch the next page. Absent on the last page.
    let nextCursor: String?
}

struct AssetResponse: Encodable {
    struct Location: Encodable {
        let latitude: Double
        let longitude: Double
        let altitude: Double?
    }

    let id: String
    let cloudIdentifier: String?
    let mediaType: String
    let mediaSubtypes: [String]
    let playbackStyle: String
    let contentType: String
    let pixelWidth: Int
    let pixelHeight: Int
    let duration: Double?
    let createdAt: Date?
    let modifiedAt: Date?
    let addedAt: Date?
    let location: Location?
    let isFavorite: Bool
    let isHidden: Bool
    let rating: Int?
    let caption: String?
    let keywords: [String]
    let originalFilename: String?
    let burstIdentifier: String?
    let representsBurst: Bool
    let sourceType: String
    let hasAdjustments: Bool
    let adjustedAt: Date?
}

struct ResourceResponse: Encodable {
    let index: Int
    let type: String
    let filename: String?
    let contentType: String
    let mimeType: String?
    let pixelWidth: Int?
    let pixelHeight: Int?
    let dataSize: Int?
}

struct AlbumResponse: Encodable {
    let id: String
    let title: String?
    let type: String
    let subtype: String
    /// Titles of the folders containing the album, outermost first.
    let folderPath: [String]
    let assetCount: Int
    let startDate: Date?
    let endDate: Date?
}

struct LibraryResponse: Encodable {
    struct Counts: Encodable {
        let image: Int
        let video: Int
        let audio: Int
    }

    let authorization: String
    let counts: Counts?
    let changeToken: String?
}

struct ChangesResponse: Encodable {
    struct Details: Encodable {
        var inserted: [String] = []
        var updated: [String] = []
        var deleted: [String] = []
    }

    /// Pass as `since` on the next call.
    let token: String
    let assets: Details
    let albums: Details
}
