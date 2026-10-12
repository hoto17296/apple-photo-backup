import Foundation
import Hummingbird
import HummingbirdTesting
import Testing

@testable import PhotoKitServer

/// Keeps the hand-written openapi.json in sync with the router.
@Suite struct OpenAPITests {
    let document: [String: Any] = {
        let json = try! JSONSerialization.jsonObject(with: Data(PackageResources.openapi_json))
        return json as! [String: Any]
    }()

    /// `GET /assets/{id}` style operations declared in the document.
    var documentedOperations: Set<String> {
        let paths = document["paths"] as! [String: [String: Any]]
        return Set(paths.flatMap { path, operations in operations.keys.map { "\($0.uppercased()) \(path)" } })
    }

    /// Operations registered in the router, with `:id` parameters rewritten to `{id}`.
    var routedOperations: Set<String> {
        let configuration = ServerConfiguration()
        let router = buildRouter(configuration: configuration, media: Media(configuration: configuration))
        return Set(
            router.routes.map { route in
                let path = route.path.description
                    .split(separator: "/", omittingEmptySubsequences: false)
                    .map { $0.hasPrefix(":") ? "{\($0.dropFirst())}" : String($0) }
                    .joined(separator: "/")
                return "\(route.method) \(path)"
            }
        )
    }

    @Test func pathsMatchRouter() {
        #expect(documentedOperations == routedOperations)
    }

    @Test func references() throws {
        // Every $ref points to an existing component.
        let data = Data(PackageResources.openapi_json)
        let text = String(decoding: data, as: UTF8.self)
        let refs = Set(text.matches(of: /"\$ref": "#\/components\/(\w+)\/(\w+)"/).map { (String($0.1), String($0.2)) }.map { "\($0.0)/\($0.1)" })
        let components = document["components"] as! [String: [String: Any]]
        for ref in refs {
            let parts = ref.split(separator: "/").map(String.init)
            #expect(components[parts[0]]?[parts[1]] != nil, "Missing component: \(ref)")
        }
    }

    @Test func served() async throws {
        let configuration = ServerConfiguration(token: "secret")
        let app = Application(router: buildRouter(configuration: configuration, media: Media(configuration: configuration)))
        try await app.test(.router) { client in
            // Available without the token.
            try await client.execute(uri: "/openapi.json", method: .get) { response in
                #expect(response.status == .ok)
                #expect(response.headers[.contentType] == "application/json; charset=utf-8")
                #expect(Data(buffer: response.body) == Data(PackageResources.openapi_json))
            }
        }
    }
}
