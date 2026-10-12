import Hummingbird
import HummingbirdTesting
import Testing

@testable import PhotoKitServer

@Suite struct RouterTests {
    func makeApp(token: String? = nil) -> some ApplicationProtocol {
        let configuration = ServerConfiguration(token: token)
        return Application(router: buildRouter(configuration: configuration, media: Media(configuration: configuration)))
    }

    @Test func health() async throws {
        try await makeApp().test(.router) { client in
            try await client.execute(uri: "/health", method: .get) { response in
                #expect(response.status == .ok)
                #expect(String(buffer: response.body) == #"{"status":"ok"}"#)
            }
        }
    }

    @Test func tokenRequired() async throws {
        try await makeApp(token: "secret").test(.router) { client in
            try await client.execute(uri: "/library", method: .get) { response in
                #expect(response.status == .unauthorized)
                #expect(String(buffer: response.body).contains(#""code":"unauthorized""#))
            }
            try await client.execute(uri: "/health", method: .get) { response in
                #expect(response.status == .ok)
            }
        }
    }

    @Test func tokenAccepted() async throws {
        // Uses a dummy route: the real routes read the Photos library, which tests must not depend on
        // (and which crashes the test process when the terminal running it has Photos access).
        let router = Router()
        router.add(middleware: BearerTokenMiddleware(token: "secret"))
        router.get("/protected") { _, _ in "ok" }
        try await Application(router: router).test(.router) { client in
            try await client.execute(uri: "/protected", method: .get, headers: [.authorization: "Bearer secret"]) { response in
                #expect(response.status == .ok)
            }
            try await client.execute(uri: "/protected", method: .get, headers: [.authorization: "Bearer wrong"]) { response in
                #expect(response.status == .unauthorized)
            }
        }
    }
}
