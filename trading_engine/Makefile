BUILD_DIR = build
DOCS_DIR = docs/html

.PHONY: all configure build clean run docs docs-serve

all: build

configure:
	cmake -B $(BUILD_DIR) -S . -DCMAKE_BUILD_TYPE=Release

build: configure
	cmake --build $(BUILD_DIR) -- -j$$(nproc)

clean:
	rm -rf $(BUILD_DIR)

run: build
	./$(BUILD_DIR)/engine

docs:
	@if command -v doxygen >/dev/null 2>&1; then \
		doxygen Doxyfile; \
		echo "Documentation generated in docs/html/"; \
		echo "Starting documentation server at http://localhost:8081"; \
		cd docs/html && python3 -m http.server 8081; \
	else \
		echo "doxygen not installed. Please install doxygen:"; \
		echo "  sudo apt install doxygen graphviz"; \
		echo "Then run: make docs"; \
	fi

docs-serve: docs
	@if command -v python3 >/dev/null 2>&1; then \
		echo "Starting docs server at http://localhost:8081"; \
		cd docs/html && python3 -m http.server 8081; \
	else \
		echo "Python3 not found. Open docs/html/index.html manually."; \
	fi
