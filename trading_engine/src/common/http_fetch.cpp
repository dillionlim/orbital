#include "common/http_fetch.hpp"

#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#include <array>
#include <cstddef>

namespace TradingSystem {

namespace {

// Wrap `s` in single quotes, escaping any embedded single quote, so it is a
// single safe shell argument no matter what it contains.
std::string shell_quote(const std::string& s) {
    std::string out = "'";
    for (char c : s) {
        if (c == '\'') out += "'\\''";
        else out += c;
    }
    out += "'";
    return out;
}

}  // namespace

HttpResponse http_fetch(const std::string& method, const std::string& url,
                        const std::string& body,
                        const std::vector<std::string>& headers,
                        int timeout_seconds) {
    HttpResponse res;

    std::string cmd = "curl -sS --max-time " + std::to_string(timeout_seconds) +
                      " -X " + method;
    for (const auto& h : headers) cmd += " -H " + shell_quote(h);
    if (!body.empty()) cmd += " --data-binary @-";  // body arrives on stdin
    // Append the HTTP status on its own trailing line so we can split it off.
    cmd += " -w '\\n%{http_code}' " + shell_quote(url);

    int in_pipe[2];   // parent -> child stdin
    int out_pipe[2];  // child stdout -> parent
    if (pipe(in_pipe) != 0) return res;
    if (pipe(out_pipe) != 0) {
        ::close(in_pipe[0]); ::close(in_pipe[1]);
        return res;
    }

    pid_t pid = ::fork();
    if (pid < 0) {
        ::close(in_pipe[0]); ::close(in_pipe[1]);
        ::close(out_pipe[0]); ::close(out_pipe[1]);
        return res;
    }
    if (pid == 0) {
        ::dup2(in_pipe[0], STDIN_FILENO);
        ::dup2(out_pipe[1], STDOUT_FILENO);
        ::close(in_pipe[0]); ::close(in_pipe[1]);
        ::close(out_pipe[0]); ::close(out_pipe[1]);
        ::execlp("sh", "sh", "-c", cmd.c_str(), nullptr);
        ::_exit(127);
    }

    ::close(in_pipe[0]);
    ::close(out_pipe[1]);
    if (!body.empty()) {
        const char* p = body.data();
        size_t left = body.size();
        while (left > 0) {
            ssize_t n = ::write(in_pipe[1], p, left);
            if (n <= 0) break;
            p += n;
            left -= static_cast<size_t>(n);
        }
    }
    ::close(in_pipe[1]);

    std::string out;
    std::array<char, 4096> buf{};
    while (true) {
        ssize_t n = ::read(out_pipe[0], buf.data(), buf.size());
        if (n <= 0) break;
        out.append(buf.data(), buf.data() + n);
        if (out.size() > (4u << 20)) break;  // 4 MiB cap
    }
    ::close(out_pipe[0]);

    int status = 0;
    ::waitpid(pid, &status, 0);
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) return res;  // transport failure

    // `out` is the response body followed by "\n<http_code>". The status code
    // contains no newline, so the LAST newline is our separator.
    auto nl = out.find_last_of('\n');
    if (nl == std::string::npos) {
        res.body = out;  // no status appended — treat as malformed
        return res;
    }
    const std::string code = out.substr(nl + 1);
    res.body = out.substr(0, nl);
    try {
        res.status = std::stol(code);
    } catch (...) {
        res.status = 0;
    }
    res.ok = res.status > 0;
    return res;
}

}  // namespace TradingSystem
