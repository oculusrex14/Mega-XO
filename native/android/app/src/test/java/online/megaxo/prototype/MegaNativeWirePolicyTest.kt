package online.megaxo.prototype

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class MegaNativeWirePolicyTest {
    @Test fun readsObjectsAndArraysWithoutReshaping() {
        assertTrue(MegaNativeWirePolicy.parseResponse("[]") is JSONArray)
        assertEquals("invite_1", (MegaNativeWirePolicy.parseResponse("[{\"id\":\"invite_1\"}]") as JSONArray)
            .getJSONObject(0).getString("id"))
        assertEquals("AUTH_REQUIRED", (MegaNativeWirePolicy.parseResponse("{\"error\":\"AUTH_REQUIRED\"}") as JSONObject).getString("error"))
        for (value in listOf("null", "true", "42", "\"text\"", "<html>error</html>", "{} trailing")) {
            assertTrue("reject $value", runCatching { MegaNativeWirePolicy.parseResponse(value) }.isFailure)
        }
    }

    @Test fun permitsOnlyExistingQueryConsumers() {
        for (value in listOf("/api/v1/profile", "/api/community/challenges", "/api/account/save",
            "/api/community/search?q=Oculus%20Rex", "/api/community/search?q=%E2%98%85",
            "/api/v1/leaderboard?scope=global&region=&league=all&metric=rating")) {
            assertTrue(value, MegaNativeWirePolicy.acceptsPath(value))
        }
        for (value in listOf("https://evil.test/api/v1/profile", "//evil.test/api/v1/profile",
            "/api/v1/../account/profile", "/api/v1/%2e%2e/account/profile", "/api/v1//profile",
            "/api/v1/profile#fragment", "/api/v1/profile?url=https://evil.test", "/api/community/search?q=%0d%0aHeader",
            "/api/community/search?q=%ZZ", "/api/community/search?q=a&q=b", "/api/community/search?actor=other",
            "/api/community/search?q=a\\b", "/api/v1/profile\n", "/api/operator/health")) {
            assertFalse(value, MegaNativeWirePolicy.acceptsPath(value))
        }
    }
}
