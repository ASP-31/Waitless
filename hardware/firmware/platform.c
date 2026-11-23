#include "hardware.h"

#ifdef HOST_SIM

/* Deterministic clock: one tick = one scripted sample. */
static uint64_t s_virtual_ms = 0u;

uint64_t platform_now_ms(void) {
  return s_virtual_ms;
}

void platform_tick(void) {
  s_virtual_ms += WAITLESS_STEP_MS;
}

void platform_delay_ms(uint32_t ms) {
  (void)ms;
}

#else /* embedded */

/* Replace with MCU SDK calls when porting to MCUXpresso or Zephyr. */
static uint64_t s_board_ms = 0u;

uint64_t platform_now_ms(void) {
  return s_board_ms;
}

void platform_tick(void) {
  s_board_ms += 100u; /* stand-in for a 100 ms RTOS tick */
}

void platform_delay_ms(uint32_t ms) {
  s_board_ms += ms;
}

#endif
