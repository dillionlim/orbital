BUILD_DIR = build

.PHONY: all build clean run help

all: build

build:
	cmake -B $(BUILD_DIR) -S . -DCMAKE_BUILD_TYPE=Release
	cmake --build $(BUILD_DIR) -- -j$$(nproc)

clean:
	rm -rf $(BUILD_DIR)

run: build
	./$(BUILD_DIR)/engine

help:
	@echo "Targets:"
	@echo "  make           Build the engine (Release)"
	@echo "  make run       Build + run"
	@echo "  make clean     Remove the build directory"
