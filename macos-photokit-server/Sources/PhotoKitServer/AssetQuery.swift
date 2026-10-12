import Foundation
import Hummingbird
import HummingbirdCore
@preconcurrency import Photos

/// Sort order for asset listings.
struct AssetSort: Equatable, Sendable {
    enum Key: String, Sendable {
        case createdAt = "created_at"
        case modifiedAt = "modified_at"
        case addedAt = "added_at"

        /// PHAsset key used in sort descriptors and predicates.
        var photosKey: String {
            switch self {
            case .createdAt: "creationDate"
            case .modifiedAt: "modificationDate"
            case .addedAt: "addedDate"
            }
        }

        func date(of asset: PHAsset) -> Date? {
            switch self {
            case .createdAt: asset.creationDate
            case .modifiedAt: asset.modificationDate
            case .addedAt: asset.addedDate
            }
        }
    }

    var key: Key
    var ascending: Bool

    static let `default` = AssetSort(key: .createdAt, ascending: false)

    /// Parses `created_at` (ascending) or `-created_at` (descending).
    init?(_ value: String) {
        let ascending = !value.hasPrefix("-")
        guard let key = Key(rawValue: ascending ? value : String(value.dropFirst())) else { return nil }
        self.init(key: key, ascending: ascending)
    }

    init(key: Key, ascending: Bool) {
        self.key = key
        self.ascending = ascending
    }

    var description: String { (ascending ? "" : "-") + key.rawValue }
}

/// Opaque pagination cursor handed to clients (keyset pagination).
///
/// Points just after the last returned asset: the next page starts at assets whose sort date
/// is at or beyond `date`, skipping the first `skip` assets that have exactly `date`.
/// Being keyset based, pages stay consistent when assets are added before the cursor.
struct AssetCursor: Codable, Equatable, Sendable {
    /// Sort the cursor was created for (e.g. `-created_at`).
    var sort: String
    /// Sort date of the last returned asset, as seconds since the reference date.
    var date: Double
    /// Number of already returned assets whose sort date equals `date`.
    var skip: Int

    func encoded() -> String {
        let data = try! JSONEncoder().encode(self)
        return data.base64URLEncodedString()
    }

    init(sort: String, date: Double, skip: Int) {
        self.sort = sort
        self.date = date
        self.skip = skip
    }

    init?(encoded: String) {
        guard let data = Data(base64URLEncoded: encoded),
            let cursor = try? JSONDecoder().decode(AssetCursor.self, from: data)
        else { return nil }
        self = cursor
    }
}

/// Filters, sort and paging parameters for asset listings, parsed from the query string.
struct AssetQuery: Sendable {
    enum Hidden: String, Sendable {
        case exclude, include, only
    }

    var mediaTypes: [PHAssetMediaType] = []
    var subtypes: PHAssetMediaSubtype = []
    var favorite: Bool?
    var hidden: Hidden = .exclude
    var from: Date?
    var to: Date?
    var sort: AssetSort = .default
    var limit = 100
    var cursor: AssetCursor?

    static let maxLimit = 1000

    init() {}

    init(parameters: FlatDictionary<Substring, Substring>) throws(APIError) {
        if let value = parameters["media_type"] {
            mediaTypes = try Self.list(value).map { name throws(APIError) in
                guard let type = PHAssetMediaType(name: name) else {
                    throw .badRequest("Unknown media_type: \(name)")
                }
                return type
            }
        }
        if let value = parameters["subtype"] {
            for name in Self.list(value) {
                guard let subtype = PHAssetMediaSubtype(name: name) else {
                    throw .badRequest("Unknown subtype: \(name)")
                }
                subtypes.insert(subtype)
            }
        }
        if let value = parameters["favorite"] {
            favorite = try Self.bool(value, name: "favorite")
        }
        if let value = parameters["hidden"] {
            guard let hidden = Hidden(rawValue: String(value)) else {
                throw .badRequest("hidden must be one of exclude, include, only")
            }
            self.hidden = hidden
        }
        if let value = parameters["from"] {
            from = try Self.date(value, name: "from")
        }
        if let value = parameters["to"] {
            to = try Self.date(value, name: "to")
        }
        if let value = parameters["sort"] {
            guard let sort = AssetSort(String(value)) else {
                throw .badRequest("sort must be one of created_at, modified_at, added_at (prefix with - for descending)")
            }
            self.sort = sort
        }
        if let value = parameters["limit"] {
            guard let limit = Int(value), (1...Self.maxLimit).contains(limit) else {
                throw .badRequest("limit must be an integer between 1 and \(Self.maxLimit)")
            }
            self.limit = limit
        }
        if let value = parameters["cursor"] {
            guard let cursor = AssetCursor(encoded: String(value)) else {
                throw .badRequest("Invalid cursor")
            }
            guard cursor.sort == sort.description else {
                throw .badRequest("cursor was created with sort=\(cursor.sort)")
            }
            self.cursor = cursor
        }
    }

    /// Fetch options selecting the page described by this query.
    /// One extra asset beyond `limit` is fetched to detect whether a next page exists.
    func fetchOptions() -> PHFetchOptions {
        var predicates: [NSPredicate] = []
        if !mediaTypes.isEmpty {
            predicates.append(
                NSCompoundPredicate(
                    orPredicateWithSubpredicates: mediaTypes.map { NSPredicate(format: "mediaType == %d", $0.rawValue) }
                )
            )
        }
        if !subtypes.isEmpty {
            predicates.append(NSPredicate(format: "(mediaSubtypes & %d) != 0", subtypes.rawValue))
        }
        if let favorite {
            predicates.append(NSPredicate(format: "favorite == %@", NSNumber(value: favorite)))
        }
        if hidden == .only {
            predicates.append(NSPredicate(format: "hidden == YES"))
        }
        if let from {
            predicates.append(NSPredicate(format: "creationDate >= %@", from as NSDate))
        }
        if let to {
            predicates.append(NSPredicate(format: "creationDate < %@", to as NSDate))
        }
        if let cursor {
            let date = Date(timeIntervalSinceReferenceDate: cursor.date) as NSDate
            let op = sort.ascending ? ">=" : "<="
            predicates.append(NSPredicate(format: "\(sort.key.photosKey) \(op) %@", date))
        }

        let options = PHFetchOptions()
        if !predicates.isEmpty {
            options.predicate = NSCompoundPredicate(andPredicateWithSubpredicates: predicates)
        }
        options.sortDescriptors = [NSSortDescriptor(key: sort.key.photosKey, ascending: sort.ascending)]
        options.includeHiddenAssets = hidden != .exclude
        options.fetchLimit = (cursor?.skip ?? 0) + limit + 1
        options.prefetchAssetExtendedMetadata = true
        return options
    }

    /// Splits a fetch result made with `fetchOptions()` into the page and the next cursor.
    func page(of result: PHFetchResult<PHAsset>) -> (assets: [PHAsset], next: AssetCursor?) {
        let start = min(cursor?.skip ?? 0, result.count)
        let end = min(start + limit, result.count)
        let assets = result.objects(at: IndexSet(integersIn: start..<end))
        guard end < result.count, let last = assets.last, let lastDate = sort.key.date(of: last) else {
            return (assets, nil)
        }
        let lastValue = lastDate.timeIntervalSinceReferenceDate
        var skip = assets.reversed().prefix { sort.key.date(of: $0) == lastDate }.count
        if let cursor, cursor.date == lastValue, skip == assets.count {
            skip += cursor.skip
        }
        return (assets, AssetCursor(sort: sort.description, date: lastValue, skip: skip))
    }

    private static func list(_ value: Substring) -> [String] {
        value.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    private static func bool(_ value: Substring, name: String) throws(APIError) -> Bool {
        switch value {
        case "true", "1": return true
        case "false", "0": return false
        default: throw .badRequest("\(name) must be true or false")
        }
    }

    private static func date(_ value: Substring, name: String) throws(APIError) -> Date {
        let string = String(value)
        if let date = try? Date(string, strategy: .iso8601) {
            return date
        }
        // Also accept a plain date (YYYY-MM-DD) in the local time zone.
        if let date = try? Date(string, strategy: Date.ISO8601FormatStyle(timeZone: .current).year().month().day()) {
            return date
        }
        throw .badRequest("\(name) must be an ISO 8601 date or date-time")
    }
}

extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    init?(base64URLEncoded string: String) {
        var base64 = string
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        self.init(base64Encoded: base64)
    }
}
