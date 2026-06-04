BUILD_DIR   = build
CONFIG      = scripts/server.json
CONFIG_EX   = scripts/server.json.example

.PHONY: all configure build clean run run-dev help

all: build

configure:
	cmake -B $(BUILD_DIR) -S . -DCMAKE_BUILD_TYPE=Release

build: configure
	cmake --build $(BUILD_DIR) -- -j$$(nproc)

clean:
	rm -rf $(BUILD_DIR)

# `make run` — build (Release) and start the trading server with scripts/server.json.
# Auto-creates the config from scripts/server.json.example on first run. The build
# also bundles docs/site/ into the binary; browse http://localhost:9090/docs after start.
run: build
	@if [ ! -f $(CONFIG) ]; then \
		echo "==> No $(CONFIG) found; copying from $(CONFIG_EX)"; \
		cp $(CONFIG_EX) $(CONFIG); \
	fi
	@echo "==> Starting engine; docs at http://localhost:$$(grep -oE '"port"[^0-9]*[0-9]+' $(CONFIG) | grep -oE '[0-9]+')/docs"
	./$(BUILD_DIR)/engine --config $(CONFIG)

# `make run-dev` — same as run but disables the in-process market maker.
run-dev: build
	@if [ ! -f $(CONFIG) ]; then cp $(CONFIG_EX) $(CONFIG); fi
	./$(BUILD_DIR)/engine --config $(CONFIG) --no-mm

help:
	@echo "Targets:"
	@echo "  make           Build the engine (alias for 'make build')"
	@echo "  make run       Build + run the engine; docs are at /docs on the engine port"
	@echo "  make run-dev   Same as run, but with the market maker disabled"
	@echo "  make clean     Remove the build directory"
