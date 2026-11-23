# Host simulation is dependency-free: cc -std=c11 -DHOST_SIM ...
CC ?= cc
CFLAGS ?= -std=c11 -Wall -Wextra -Werror
HOST_CFLAGS := $(CFLAGS) -DHOST_SIM
BUILD_DIR := build
HOST_BIN := $(BUILD_DIR)/waitless-host-sim

HOST_SRCS := main.c platform.c sensor.c publisher.c
HOST_OBJS := $(HOST_SRCS:%.c=$(BUILD_DIR)/host-%.o)

.PHONY: all host run clean embedded help

all: host

host: $(HOST_BIN)

$(HOST_BIN): $(HOST_OBJS)
	$(CC) $(HOST_CFLAGS) -o $@ $^

$(BUILD_DIR)/host-%.o: %.c hardware.h
	@mkdir -p $(BUILD_DIR)
	$(CC) $(HOST_CFLAGS) -c -o $@ $<

run: host
	$(HOST_BIN) --room OPD-1 --script 1,1,0,0,1

embedded:
	@echo "Embedded builds are SDK-specific:"
	@echo "  MCUXpresso: create a C project with these sources, define WAITLESS_HMAC_MBEDTLS, wire sensor.c/publisher.c to the SDK."
	@echo "  Zephyr: add this directory as an app (CMakeLists.txt + prj.conf) and map platform_now_ms()/publisher_* to Zephyr APIs."
	@echo "  See ../docs/wiring.md and README.md."

clean:
	rm -rf $(BUILD_DIR)

help:
	@echo "make host   - build the dependency-free host simulator"
	@echo "make run    - build and print a scripted occupancy/heartbeat sequence"
	@echo "make embedded - show MCU porting notes"
