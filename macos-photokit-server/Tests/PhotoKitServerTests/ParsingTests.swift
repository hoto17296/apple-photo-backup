import Foundation
import Hummingbird
import Testing

@testable import PhotoKitServer

@Suite struct ByteRangeTests {
    @Test func closedRange() {
        #expect(ByteRange(header: "bytes=0-99", size: 1000)?.range == 0..<100)
    }

    @Test func endBeyondSizeIsClamped() {
        #expect(ByteRange(header: "bytes=900-2000", size: 1000)?.range == 900..<1000)
    }

    @Test func openEnded() {
        #expect(ByteRange(header: "bytes=500-", size: 1000)?.range == 500..<1000)
    }

    @Test func suffix() {
        #expect(ByteRange(header: "bytes=-100", size: 1000)?.range == 900..<1000)
        #expect(ByteRange(header: "bytes=-5000", size: 1000)?.range == 0..<1000)
    }

    @Test(arguments: ["bytes=1000-", "bytes=5-1", "bytes=0-1,5-6", "items=0-1", "bytes=-0", "bytes=-", "bytes=a-b"])
    func unsatisfiable(header: String) {
        #expect(ByteRange(header: header, size: 1000) == nil)
    }
}

@Suite struct AssetCursorTests {
    @Test func roundTrip() {
        let cursor = AssetCursor(sort: "-created_at", date: 781_234_567.123456, skip: 3)
        #expect(AssetCursor(encoded: cursor.encoded()) == cursor)
    }

    @Test func encodedIsURLSafe() {
        let encoded = AssetCursor(sort: "-created_at", date: 1.5, skip: 0).encoded()
        #expect(!encoded.contains(where: { "+/=".contains($0) }))
    }

    @Test func invalid() {
        #expect(AssetCursor(encoded: "not a cursor") == nil)
    }
}

@Suite struct AssetSortTests {
    @Test func parse() {
        #expect(AssetSort("created_at") == AssetSort(key: .createdAt, ascending: true))
        #expect(AssetSort("-modified_at") == AssetSort(key: .modifiedAt, ascending: false))
        #expect(AssetSort("-added_at")?.description == "-added_at")
        #expect(AssetSort("title") == nil)
    }
}

@Suite struct ChangeAccumulatorTests {
    @Test func netChanges() {
        var changes = ChangeAccumulator()
        changes.apply(inserted: ["a", "b"], updated: ["x"], deleted: ["y"])
        changes.apply(inserted: [], updated: ["a", "z"], deleted: ["b", "x"])
        let details = changes.details
        // a: inserted then updated -> inserted; b: inserted then deleted -> gone
        #expect(details.inserted == ["a"])
        #expect(details.updated == ["z"])
        #expect(details.deleted == ["x", "y"])
    }

    @Test func reinsertedAfterDelete() {
        var changes = ChangeAccumulator()
        changes.apply(inserted: [], updated: [], deleted: ["a"])
        changes.apply(inserted: ["a"], updated: [], deleted: [])
        #expect(changes.details.inserted == ["a"])
        #expect(changes.details.deleted == [])
    }
}

@Suite struct BearerTokenTests {
    @Test func matches() {
        #expect(BearerTokenMiddleware<BasicRequestContext>.matches("Bearer secret", token: "secret"))
        #expect(!BearerTokenMiddleware<BasicRequestContext>.matches("Bearer secreT", token: "secret"))
        #expect(!BearerTokenMiddleware<BasicRequestContext>.matches("Bearer secret2", token: "secret"))
        #expect(!BearerTokenMiddleware<BasicRequestContext>.matches("secret", token: "secret"))
        #expect(!BearerTokenMiddleware<BasicRequestContext>.matches(nil, token: "secret"))
    }
}
