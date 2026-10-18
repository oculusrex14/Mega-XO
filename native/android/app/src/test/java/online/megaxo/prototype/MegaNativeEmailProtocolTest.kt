package online.megaxo.prototype

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class MegaNativeEmailProtocolTest {
    @Test fun newSignupCarriesMaskedEmailAndNoAnonymousCredentialToThePage() {
        val reply = MegaNativeEmailProtocol.unlinked("continue", JSONObject("""
            {"verificationRequired":true,"challengeId":"chal_123",
             "email":"a***@example.com","sessionToken":"ttttttttttttttttttttttttttttttttttttttttttt",
             "expiresAt":123,"resendAt":100,"delivery":{"code":"123456"}}
        """.trimIndent()))
        assertTrue(reply.getBoolean("ok"))
        assertEquals("a***@example.com", reply.getString("email"))
        assertEquals("chal_123", reply.getString("challengeId"))
        assertFalse(reply.has("sessionToken"))
        assertFalse(reply.has("delivery"))
        assertFalse(reply.has("code"))
    }

    @Test fun guestChallengeUsesServerTokenOnlyInsideNativeSessionManager() {
        val token = "a".repeat(43)
        assertEquals(token, MegaNativeEmailProtocol.anonymousContinuation(JSONObject().put("sessionToken", token)))
        for (bad in listOf("", "token with spaces", "abc", "https://evil.example")) {
            assertNull(MegaNativeEmailProtocol.anonymousContinuation(JSONObject().put("sessionToken", bad)))
        }
    }

    @Test fun resetFlowDistinguishesProofFromLinkedGrant() {
        val forgotten = MegaNativeEmailProtocol.unlinked("forgot", JSONObject()
            .put("challengeId", "reset_1").put("message", "If this email has an account, a reset code has been requested."))
        assertFalse(forgotten.getBoolean("linked"))
        assertEquals("reset_1", forgotten.getString("challengeId"))
        val ready = MegaNativeEmailProtocol.unlinked("verify", JSONObject()
            .put("challengeId", "reset_1").put("resetReady", true))
        assertTrue(ready.getBoolean("resetReady"))
        assertTrue(runCatching { MegaNativeEmailProtocol.unlinked("reset", JSONObject().put("challengeId", "reset_1")) }.isFailure)
    }

    @Test fun malformedSuccessCannotBecomeAnApparentSuccessfulEmailAction() {
        for ((action, body) in listOf(
            "continue" to JSONObject(),
            "continue" to JSONObject().put("challengeId", "challenge"),
            "forgot" to JSONObject().put("challengeId", "challenge"),
            "verify" to JSONObject().put("challengeId", "challenge"),
            "reset" to JSONObject().put("challengeId", "challenge")
        )) {
            assertTrue(action, runCatching { MegaNativeEmailProtocol.unlinked(action, body) }.isFailure)
        }
    }

    @Test fun publicErrorsRemainBoundedAndExcludeProviderDescriptions() {
        val known = MegaNativeEmailProtocol.error("OTP_COOLDOWN", 429)
        assertEquals("OTP_COOLDOWN", known.getString("error"))
        assertEquals(429, known.getInt("status"))
        assertEquals("SERVICE_UNAVAILABLE", MegaNativeEmailProtocol.error(
            "Failed to deliver a code to private@example.com", 502).getString("error"))
    }
}
