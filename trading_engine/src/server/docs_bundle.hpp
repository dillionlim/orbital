#pragma once
#include <cstddef>
#include <string>
#include <unordered_map>

namespace TradingSystem {

struct DocsAsset {
    const unsigned char* data;
    std::size_t size;
    const char* mime;
};

// Implemented by the auto-generated docs_bundle.generated.cpp produced by
// scripts/bundle_docs.py at build time. Maps relative path (e.g. "index.html",
// "doxygen.css", "subdir/foo.png") → embedded bytes + MIME type.
const std::unordered_map<std::string, DocsAsset>& docs_assets();

}
