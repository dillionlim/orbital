#pragma once
#include <string>
#include <vector>

namespace TradingSystem {

struct HttpResponse {
    bool ok = false;     // curl ran and produced a status line
    long status = 0;     // HTTP status code (0 if the request never completed)
    std::string body;    // response body (curl already de-chunks / de-TLSes it)
};

// Perform an HTTP(S) request by shelling out to curl. The engine links no TLS
// of its own, so `https://` URLs work only through curl (same approach as the
// Gemini news client and the index-price feed).
//
//   method  : "GET" / "POST" (any verb curl accepts)
//   url      : full URL including scheme — http:// or https://
//   body     : request body; sent on the child's stdin so API keys / secrets
//              never appear on the command line (and thus never in `ps`)
//   headers  : full "Name: value" header lines
//
// Returns ok=false on a transport failure (DNS, connect, curl missing). A
// non-2xx HTTP response still returns ok=true with the status set, so callers
// decide how to treat it.
HttpResponse http_fetch(const std::string& method, const std::string& url,
                        const std::string& body = "",
                        const std::vector<std::string>& headers = {},
                        int timeout_seconds = 10);

}  // namespace TradingSystem
