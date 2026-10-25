# Baut die Klangerzeugung als freistehendes WebAssembly (ohne Emscripten, ohne libc).
# Voraussetzung: clang und wasm-ld (Paket lld), Version 15 oder neuer.

CLANG   ?= clang
WASM    := docs/trautonium.wasm
CFLAGS  := --target=wasm32 -std=c11 -O3 -nostdlib -ffreestanding \
           -mbulk-memory -Wall -Wextra -Werror
LDFLAGS := -Wl,--no-entry -Wl,--strip-all -Wl,--initial-memory=1048576 \
           -Wl,--max-memory=1048576 -Wl,-z,stack-size=65536

.PHONY: all test smoke serve clean

all: $(WASM)

$(WASM): dsp/trautonium.c
	$(CLANG) $(CFLAGS) $(LDFLAGS) -o $@ $<

test: $(WASM)
	node --test tests/*.test.mjs

# Rauchtest im Browser; braucht Playwright mit Chromium (npm i -g playwright).
smoke: $(WASM)
	NODE_PATH=$$(npm root -g) node tests/browser-smoke.cjs

serve: $(WASM)
	python3 -m http.server --directory docs 8000

clean:
	rm -f $(WASM)
