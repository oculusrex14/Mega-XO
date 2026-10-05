import AuthenticationServices
import Foundation

/// Native adapter source; integrate into the real app target and retain this object
/// until the delegate finishes. The request uses a fresh nonce from the Mega XO server.
@MainActor
final class MegaAppleIdentity: NSObject, ASAuthorizationControllerDelegate,
    ASAuthorizationControllerPresentationContextProviding {
    enum IdentityError: Error { case alreadyRunning, invalidNonce, missingIdentityToken }
    private var completion: ((Result<String, Error>) -> Void)?
    private var window: ASPresentationAnchor?
    private var controller: ASAuthorizationController?

    func getCredential(nonce: String, window: ASPresentationAnchor,
                       completion: @escaping (Result<String, Error>) -> Void) {
        guard self.completion == nil else {
            completion(.failure(IdentityError.alreadyRunning)); return
        }
        guard !nonce.isEmpty else {
            completion(.failure(IdentityError.invalidNonce)); return
        }
        self.window = window
        self.completion = completion
        let request = ASAuthorizationAppleIDProvider().createRequest()
        request.requestedScopes = [] // Players choose their in-game name.
        request.nonce = nonce
        let controller = ASAuthorizationController(authorizationRequests: [request])
        self.controller = controller
        controller.delegate = self
        controller.presentationContextProvider = self
        controller.performRequests()
    }
    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        // Set before performRequests; the owning app must pass its active scene window.
        precondition(window != nil)
        return window!
    }
    func authorizationController(controller: ASAuthorizationController,
                                 didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let bytes = credential.identityToken,
              let token = String(data: bytes, encoding: .utf8) else {
            finish(.failure(IdentityError.missingIdentityToken)); return
        }
        finish(.success(token))
    }
    func authorizationController(controller: ASAuthorizationController,
                                 didCompleteWithError error: Error) {
        finish(.failure(error))
    }
    private func finish(_ result: Result<String, Error>) {
        let callback = completion
        completion = nil
        controller = nil
        window = nil
        callback?(result)
    }
}
