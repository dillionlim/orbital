#include <iostream>
#include <string>
#include <thread>
#include <atomic>
#include <csignal>
#include <memory>
#include <chrono>
#include <vector>
#include <sstream>
#include <mutex>
#include <fstream>
#include <set>
#include <regex>
#include <sys/socket.h>
#include <netinet/in.h>
#include <netdb.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <cstring>
#include <cstdlib>

namespace TradingSystem {
    class ServerMetrics {
    public:
        std::atomic<uint64_t> totalConnections{0};
        std::atomic<uint64_t> activeConnections{0};
        std::atomic<uint64_t> totalRequests{0};
        std::atomic<uint64_t> totalErrors{0};
        std::atomic<uint64_t> startTime{0};

        void recordConnection() {
            ++totalConnections;
            ++activeConnections;
        }

        void closeConnection() {
            --activeConnections;
        }

        void recordRequest() {
            ++totalRequests;
        }

        void recordError() {
            ++totalErrors;
        }

        uint64_t getUptimeSeconds() const {
            if (startTime == 0) return 0;
            auto now = std::chrono::duration_cast<std::chrono::seconds>(
                std::chrono::steady_clock::now().time_since_epoch()).count();
            return now - startTime;
        }

        std::string getMetricsJson() const {
            std::ostringstream oss;
            oss << "{\n";
            oss << "  \"uptime_seconds\": " << getUptimeSeconds() << ",\n";
            oss << "  \"total_connections\": " << totalConnections.load() << ",\n";
            oss << "  \"active_connections\": " << activeConnections.load() << ",\n";
            oss << "  \"total_requests\": " << totalRequests.load() << ",\n";
            oss << "  \"total_errors\": " << totalErrors.load() << "\n";
            oss << "}";
            return oss.str();
        }

        std::string getStatusJson() const {
            std::ostringstream oss;
            oss << "{\n";
            oss << "  \"status\": \"running\",\n";
            oss << "  \"port\": 8080,\n";
            oss << "  \"version\": \"1.0.0\",\n";
            oss << "  \"uptime_seconds\": " << getUptimeSeconds() << ",\n";
            oss << "  \"metrics\": {\n";
            oss << "    \"total_connections\": " << totalConnections.load() << ",\n";
            oss << "    \"active_connections\": " << activeConnections.load() << ",\n";
            oss << "    \"total_requests\": " << totalRequests.load() << ",\n";
            oss << "    \"total_errors\": " << totalErrors.load() << "\n";
            oss << "  }\n";
            oss << "}";
            return oss.str();
        }
    };

    class ApiKeyAuthenticator {
    private:
        std::set<std::string> validApiKeys;
        std::mutex mutex;
        std::string backendUrl;
        std::atomic<bool> useBackendAuth;

    public:
        ApiKeyAuthenticator() : useBackendAuth(true), backendUrl("http://localhost:3010") {}

        void setBackendUrl(const std::string& url) {
            backendUrl = url;
        }

        bool validateApiKey(const std::string& apiKey) {
            if (apiKey.empty()) {
                std::cout << "Empty API key provided" << std::endl;
                return false;
            }

            std::cout << "Validating API Key: '" << apiKey << "'" << std::endl;

            std::regex apiKeyPattern("^sk_live_[a-f0-9]{32}$");
            if (!std::regex_match(apiKey, apiKeyPattern)) {
                std::cout << "API Key regex mismatch" << std::endl;
                return false;
            }

            std::lock_guard<std::mutex> lock(mutex);
            if (validApiKeys.count(apiKey) > 0) {
                std::cout << "API Key found in cache" << std::endl;
                return true;
            }

            if (useBackendAuth) {
                bool isValid = validateWithBackend(apiKey);
                if (isValid) {
                    std::cout << "API Key validated with backend" << std::endl;
                    validApiKeys.insert(apiKey);
                } else {
                    std::cout << "API Key rejected by backend" << std::endl;
                }
                return isValid;
            }

            return false;
        }

        bool validateWithBackend(const std::string& apiKey) {
            int sockfd = socket(AF_INET, SOCK_STREAM, 0);
            if (sockfd < 0) {
                return false;
            }

            struct sockaddr_in serv_addr;
            memset(&serv_addr, 0, sizeof(serv_addr));
            serv_addr.sin_family = AF_INET;
            serv_addr.sin_port = htons(3010);
            serv_addr.sin_addr.s_addr = inet_addr("127.0.0.1");

            if (connect(sockfd, (struct sockaddr*)&serv_addr, sizeof(serv_addr)) < 0) {
                close(sockfd);
                return false;
            }

            std::string request = "GET /api-keys/validate?key=" + apiKey + " HTTP/1.1\r\n";
            request += "Host: localhost:3010\r\n";
            request += "Connection: close\r\n\r\n";

            send(sockfd, request.c_str(), request.length(), 0);

            char buffer[4096] = {0};
            int n = read(sockfd, buffer, sizeof(buffer) - 1);
            close(sockfd);

            if (n > 0) {
                std::string response(buffer);
                return response.find("200 OK") != std::string::npos &&
                       (response.find("\"valid\":true") != std::string::npos || 
                        response.find("\"valid\": true") != std::string::npos);
            }

            return false;
        }

        void addValidKey(const std::string& apiKey) {
            std::lock_guard<std::mutex> lock(mutex);
            validApiKeys.insert(apiKey);
        }

        void removeKey(const std::string& apiKey) {
            std::lock_guard<std::mutex> lock(mutex);
            validApiKeys.erase(apiKey);
        }

        void setUseBackendAuth(bool useBackend) {
            useBackendAuth = useBackend;
        }
    };

    class TradingServer {
    public:
        TradingServer() : running_(false), port_(8080), monitorPort_(9090) {}

        bool start() {
            running_ = true;
            metrics_.startTime = std::chrono::duration_cast<std::chrono::seconds>(
                std::chrono::steady_clock::now().time_since_epoch()).count();
            
            authenticator_ = std::make_unique<ApiKeyAuthenticator>();
            
            std::cout << "Starting Trading Server on port " << port_ << "..." << std::endl;
            std::cout << "Monitoring available at http://localhost:" << monitorPort_ << std::endl;
            std::cout << "  - Health: http://localhost:" << monitorPort_ << "/health" << std::endl;
            std::cout << "  - Status: http://localhost:" << monitorPort_ << "/status" << std::endl;
            std::cout << "  - Metrics: http://localhost:" << monitorPort_ << "/metrics" << std::endl;
            std::cout << "  - Auth: http://localhost:" << monitorPort_ << "/auth" << std::endl;
            std::cout << "  - OrderBook: http://localhost:" << monitorPort_ << "/orderbook" << std::endl;
            std::cout << "Trading Server is now running!" << std::endl;
            return true;
        }

        void stop() {
            running_ = false;
            std::cout << "Trading Server stopped." << std::endl;
        }

        bool isRunning() const { return running_; }

        void setPort(int port) { port_ = port; }
        int getPort() const { return port_; }

        ServerMetrics& getMetrics() { return metrics_; }
        ApiKeyAuthenticator& getAuthenticator() { return *authenticator_; }

        void runMonitorServer() {
            int sockfd = socket(AF_INET, SOCK_STREAM, 0);
            if (sockfd < 0) {
                std::cerr << "Failed to create monitoring socket" << std::endl;
                return;
            }

            int opt = 1;
            setsockopt(sockfd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

            struct sockaddr_in serv_addr;
            memset(&serv_addr, 0, sizeof(serv_addr));
            serv_addr.sin_family = AF_INET;
            serv_addr.sin_addr.s_addr = INADDR_ANY;
            serv_addr.sin_port = htons(monitorPort_);

            if (bind(sockfd, (struct sockaddr*)&serv_addr, sizeof(serv_addr)) < 0) {
                std::cerr << "Failed to bind monitoring socket to port " << monitorPort_ << std::endl;
                close(sockfd);
                return;
            }

            listen(sockfd, 5);
            std::cout << "Monitoring server listening on port " << monitorPort_ << std::endl;

            while (running_) {
                struct sockaddr_in cli_addr;
                socklen_t clilen = sizeof(cli_addr);
                int newsockfd = accept(sockfd, (struct sockaddr*)&cli_addr, &clilen);

                if (newsockfd < 0) {
                    if (running_) {
                        std::cerr << "Error accepting connection" << std::endl;
                    }
                    continue;
                }

                metrics_.recordConnection();
                handleMonitorRequest(newsockfd);
                metrics_.closeConnection();
            }

            close(sockfd);
        }

    private:
        void handleMonitorRequest(int sockfd) {
            char buffer[8192] = {0};
            int bytesRead = read(sockfd, buffer, sizeof(buffer) - 1);

            if (bytesRead <= 0) {
                close(sockfd);
                return;
            }

            std::string request(buffer);
            std::string path = parsePath(request);
            std::string method = parseMethod(request);

            std::string response;
            
            if (method == "OPTIONS") {
                response = buildCorsPreflightResponse();
            } else if (path == "/health" || path.find("/health?") == 0) {
                response = buildResponse(200, "{\"status\": \"healthy\"}", "application/json");
            } else if (path == "/status" || path.find("/status?") == 0) {
                response = buildResponse(200, metrics_.getStatusJson(), "application/json");
            } else if (path == "/metrics" || path.find("/metrics?") == 0) {
                response = buildResponse(200, metrics_.getMetricsJson(), "application/json");
            } else if (path == "/auth" || path.find("/auth?") == 0) {
                if (method == "POST") {
                    response = handleAuthRequest(request);
                } else {
                    response = buildResponse(405, "Method Not Allowed", "text/plain");
                }
            } else if (path.substr(0, 10) == "/orderbook") {
                response = handleOrderBookRequest(path, request);
            } else {
                response = buildResponse(404, "Not Found", "text/plain");
            }

            metrics_.recordRequest();
            write(sockfd, response.c_str(), response.length());
            close(sockfd);
        }

        std::string buildCorsPreflightResponse() {
            std::ostringstream oss;
            oss << "HTTP/1.1 204 No Content\r\n";
            oss << "Access-Control-Allow-Origin: *\r\n";
            oss << "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n";
            oss << "Access-Control-Allow-Headers: Origin, Content-Type, Authorization, Api-Key, Accept, Access-Control-Request-Method, Access-Control-Request-Headers, Cache-Control, Pragma\r\n";
            oss << "Access-Control-Max-Age: 86400\r\n";
            oss << "Access-Control-Allow-Credentials: false\r\n";
            oss << "Connection: close\r\n";
            oss << "\r\n";
            return oss.str();
        }

        std::string buildResponse(int statusCode, const std::string& body, const std::string& contentType) {
            std::ostringstream oss;
            oss << "HTTP/1.1 " << statusCode << " ";
            if (statusCode == 200) oss << "OK";
            else if (statusCode == 401) oss << "Unauthorized";
            else if (statusCode == 404) oss << "Not Found";
            else if (statusCode == 405) oss << "Method Not Allowed";
            else oss << "Error";
            oss << "\r\n";
            oss << "Content-Type: " << contentType << "\r\n";
            oss << "Content-Length: " << body.length() << "\r\n";
            oss << "Access-Control-Allow-Origin: *\r\n";
            oss << "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n";
            oss << "Access-Control-Allow-Headers: Origin, Content-Type, Authorization, Api-Key, Accept, Cache-Control, Pragma\r\n";
            oss << "Access-Control-Allow-Credentials: false\r\n";
            oss << "Connection: close\r\n";
            oss << "\r\n";
            oss << body;
            return oss.str();
        }

        std::string handleAuthRequest(const std::string& request) {
            std::string apiKey = extractApiKey(request);
            
            if (apiKey.empty()) {
                return buildResponse(401, "{\"error\": \"Missing API key\"}", "application/json");
            }

            bool isValid = authenticator_->validateApiKey(apiKey);
            
            if (isValid) {
                std::ostringstream response;
                response << "{\"authenticated\": true, \"message\": \"API key validated successfully\"}";
                return buildResponse(200, response.str(), "application/json");
            } else {
                std::ostringstream response;
                response << "{\"authenticated\": false, \"error\": \"Invalid API key\"}";
                return buildResponse(401, response.str(), "application/json");
            }
        }

        std::string handleOrderBookRequest(const std::string& path, const std::string& request) {
            std::string apiKey = extractApiKey(request);
            
            if (!apiKey.empty()) {
                bool isValid = authenticator_->validateApiKey(apiKey);
                if (!isValid) {
                    return buildResponse(401, "{\"error\": \"Invalid API key\"}", "application/json");
                }
            }

            std::string symbol = extractQueryParam(path, "symbol");
            if (symbol.empty()) {
                symbol = "btc";
            }

            int depth = 10;

            std::string bidsJson, asksJson;
            generateOrderBook(symbol, depth, bidsJson, asksJson);
            
            std::ostringstream response;
            response << "{\"symbol\": \"" << symbol << "-USD\", \"timestamp\": \"" 
                     << std::chrono::duration_cast<std::chrono::milliseconds>(
                         std::chrono::steady_clock::now().time_since_epoch()).count()
                     << "\", \"bids\": [" << bidsJson << "], \"asks\": [" << asksJson << "]}";
            
            return buildResponse(200, response.str(), "application/json");
        }

        void generateOrderBook(const std::string& symbol, int depth, std::string& bidsJson, std::string& asksJson) {
            double basePrice = 50000.0;
            if (symbol == "eth") basePrice = 3000.0;
            else if (symbol == "ltc") basePrice = 100.0;

            std::ostringstream bids, asks;
            
            for (int i = 0; i < depth; i++) {
                if (i > 0) bids << ", ";
                double price = basePrice - (i * 10) - (rand() % 100 * 0.1);
                double size = 0.1 + (rand() % 1000) / 100.0;
                bids << "{\"price\": " << price << ", \"size\": " << size 
                     << ", \"total\": " << (price * size) << "}";
            }

            for (int i = 0; i < depth; i++) {
                if (i > 0) asks << ", ";
                double price = basePrice + (i * 10) + (rand() % 100 * 0.1);
                double size = 0.1 + (rand() % 1000) / 100.0;
                asks << "{\"price\": " << price << ", \"size\": " << size 
                     << ", \"total\": " << (price * size) << "}";
            }

            bidsJson = bids.str();
            asksJson = asks.str();
        }

        std::string extractApiKey(const std::string& request) {
            // 1. Check Authorization header
            size_t authPos = request.find("Authorization:");
            if (authPos == std::string::npos) {
                authPos = request.find("authorization:");
            }
            
            if (authPos != std::string::npos) {
                size_t start = request.find("Bearer ", authPos);
                if (start != std::string::npos) {
                    start += 7;
                    size_t end = request.find("\r\n", start);
                    if (end == std::string::npos) {
                        end = request.find("\n", start);
                    }
                    if (end != std::string::npos) {
                        return request.substr(start, end - start);
                    }
                    return request.substr(start);
                }
            }

            // 2. Check Api-Key header
            size_t apiPos = request.find("Api-Key:");
            if (apiPos == std::string::npos) {
                apiPos = request.find("api-key:");
            }

            if (apiPos != std::string::npos) {
                size_t start = apiPos + 8;
                // Skip whitespace
                while (start < request.length() && request[start] == ' ') {
                    start++;
                }

                size_t end = request.find("\r\n", start);
                if (end == std::string::npos) {
                    end = request.find("\n", start);
                }
                if (end != std::string::npos) {
                    return request.substr(start, end - start);
                }
                return request.substr(start);
            }

            // 3. Check query param
            size_t keyPos = request.find("?api_key=");
            if (keyPos == std::string::npos) {
                keyPos = request.find("&api_key=");
            }
            if (keyPos != std::string::npos) {
                keyPos += 9;
                size_t end = request.find("&", keyPos);
                if (end == std::string::npos) {
                    end = request.find(" ", keyPos);
                }
                if (end != std::string::npos) {
                    return request.substr(keyPos, end - keyPos);
                }
                return request.substr(keyPos);
            }

            return "";
        }

        std::string extractQueryParam(const std::string& path, const std::string& param) {
            size_t pos = path.find(param + "=");
            if (pos == std::string::npos) {
                return "";
            }
            pos += param.length() + 1;
            size_t end = path.find("&", pos);
            if (end == std::string::npos) {
                end = path.find(" ", pos);
            }
            if (end == std::string::npos) {
                end = path.length();
            }
            return path.substr(pos, end - pos);
        }

        std::string parsePath(const std::string& request) {
            size_t start = request.find("GET ") + 4;
            if (start == std::string::npos || start == 3) {
                start = request.find("POST ") + 5;
            }
            size_t end = request.find(" ", start);
            if (start == std::string::npos || end == std::string::npos || start >= request.length()) {
                return "/";
            }
            return request.substr(start, end - start);
        }

        std::string parseMethod(const std::string& request) {
            if (request.find("POST ") == 0) return "POST";
            if (request.find("OPTIONS ") == 0) return "OPTIONS";
            if (request.find("GET ") == 0) return "GET";
            if (request.find("HEAD ") == 0) return "HEAD";
            return "GET";
        }

        std::atomic<bool> running_;
        int port_;
        int monitorPort_;
        ServerMetrics metrics_;
        std::unique_ptr<ApiKeyAuthenticator> authenticator_;
    };
}

std::unique_ptr<TradingSystem::TradingServer> server;
std::unique_ptr<std::thread> monitorThread;

std::string parsePath(const std::string& request);
std::string readFile(const std::string& path);
std::string getContentType(const std::string& path);
std::string buildHttpResponse(const std::string& body, const std::string& contentType);

void signalHandler(int signum) {
    std::cout << "\nReceived signal " << signum << ", shutting down..." << std::endl;
    if (server) {
        server->stop();
    }
    if (monitorThread && monitorThread->joinable()) {
        monitorThread->join();
    }
    exit(signum);
}

void runDocsServer() {
    std::cout << "Starting Documentation Server..." << std::endl;
    std::cout << "Serving docs from: docs/html/" << std::endl;
    
    std::ifstream testFile("docs/html/index.html");
    if (!testFile.good()) {
        std::cerr << "Warning: docs/html/index.html not found. Run 'make docs' first." << std::endl;
        std::cerr << "Documentation will not be available." << std::endl;
    }

    int sockfd = socket(AF_INET, SOCK_STREAM, 0);
    if (sockfd < 0) {
        std::cerr << "Failed to create docs server socket" << std::endl;
        return;
    }

    int opt = 1;
    setsockopt(sockfd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    struct sockaddr_in serv_addr;
    memset(&serv_addr, 0, sizeof(serv_addr));
    serv_addr.sin_family = AF_INET;
    serv_addr.sin_addr.s_addr = INADDR_ANY;
    serv_addr.sin_port = htons(8081);

    if (bind(sockfd, (struct sockaddr*)&serv_addr, sizeof(serv_addr)) < 0) {
        std::cerr << "Failed to bind docs server to port 8081" << std::endl;
        close(sockfd);
        return;
    }

    listen(sockfd, 5);
    std::cout << "Documentation server listening on http://localhost:8081" << std::endl;
    std::cout << "Press Ctrl+C to stop." << std::endl;

    while (true) {
        struct sockaddr_in cli_addr;
        socklen_t clilen = sizeof(cli_addr);
        int newsockfd = accept(sockfd, (struct sockaddr*)&cli_addr, &clilen);

        if (newsockfd < 0) {
            continue;
        }

        char buffer[4096] = {0};
        read(newsockfd, buffer, sizeof(buffer) - 1);

        std::string path = parsePath(buffer);
        std::string filePath = "docs/html" + path;
        
        if (path == "/") {
            filePath = "docs/html/index.html";
        }

        std::string content = readFile(filePath);
        std::string contentType = getContentType(path);

        std::string response = buildHttpResponse(content, contentType);
        write(newsockfd, response.c_str(), response.length());
        close(newsockfd);
    }

    close(sockfd);
}

std::string parsePath(const std::string& request) {
    size_t start = request.find("GET ") + 4;
    size_t end = request.find(" ", start);
    if (start == std::string::npos || end == std::string::npos) {
        return "/";
    }
    return request.substr(start, end - start);
}

std::string readFile(const std::string& path) {
    std::ifstream file(path);
    if (!file.is_open()) {
        return "<html><body><h1>404 Not Found</h1></body></html>";
    }
    std::stringstream buffer;
    buffer << file.rdbuf();
    return buffer.str();
}

std::string getContentType(const std::string& path) {
    if (path.find(".html") != std::string::npos) return "text/html";
    if (path.find(".css") != std::string::npos) return "text/css";
    if (path.find(".js") != std::string::npos) return "application/javascript";
    if (path.find(".png") != std::string::npos) return "image/png";
    if (path.find(".jpg") != std::string::npos) return "image/jpeg";
    if (path.find(".svg") != std::string::npos) return "image/svg+xml";
    return "text/plain";
}

std::string buildHttpResponse(const std::string& body, const std::string& contentType) {
    std::ostringstream oss;
    if (body.find("<html") != std::string::npos && body.find("404") != std::string::npos) {
        oss << "HTTP/1.1 404 Not Found\r\n";
    } else {
        oss << "HTTP/1.1 200 OK\r\n";
    }
    oss << "Content-Type: " << contentType << "\r\n";
    oss << "Content-Length: " << body.length() << "\r\n";
    oss << "Connection: close\r\n";
    oss << "\r\n";
    oss << body;
    return oss.str();
}

void printUsage(const char* programName) {
    std::cout << "Usage: " << programName << " [OPTIONS]" << std::endl;
    std::cout << std::endl;
    std::cout << "Options:" << std::endl;
    std::cout << "  --docs       Run the documentation server (default port 8081)" << std::endl;
    std::cout << "  --help       Show this help message" << std::endl;
    std::cout << std::endl;
    std::cout << "Without options, runs the trading server." << std::endl;
}

int main(int argc, char* argv[]) {
    signal(SIGINT, signalHandler);
    signal(SIGTERM, signalHandler);

    bool runDocs = false;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--docs") {
            runDocs = true;
        } else if (arg == "--help" || arg == "-h") {
            printUsage(argv[0]);
            return 0;
        }
    }

    if (runDocs) {
        runDocsServer();
        return 0;
    }

    server = std::make_unique<TradingSystem::TradingServer>();

    std::cout << "Initializing Trading Engine..." << std::endl;

    if (!server->start()) {
        std::cerr << "Failed to start Trading Server" << std::endl;
        return 1;
    }

    monitorThread = std::make_unique<std::thread>(&TradingSystem::TradingServer::runMonitorServer, server.get());
    monitorThread->detach();

    std::cout << "Trading Server is ready and listening for connections." << std::endl;

    while (server->isRunning()) {
        std::this_thread::sleep_for(std::chrono::seconds(1));
    }

    return 0;
}
