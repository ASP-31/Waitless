#include "hardware.h"

#ifdef HOST_SIM
#define WAITLESS_MAX_SAMPLES 128u

static int s_samples[WAITLESS_MAX_SAMPLES];
static size_t s_count = 0u;
static size_t s_cursor = 0u;

void sensor_init(void) {
  s_count = 0u;
  s_cursor = 0u;
}

void sensor_load_script(const int *samples, size_t count) {
  s_count = count < WAITLESS_MAX_SAMPLES ? count : WAITLESS_MAX_SAMPLES;
  for (size_t i = 0u; i < s_count; ++i) {
    s_samples[i] = samples[i] ? 1 : 0;
  }
  s_cursor = 0u;
}

int sensor_read(void) {
  if (s_cursor >= s_count) return -1;
  return s_samples[s_cursor++];
}

#else /* embedded */

/* Board bring-up: read the GPIO attached to the occupancy sensor. Replace the
 * stub with GPIO_PinRead() (MCUXpresso) or gpio_pin_get_dt() (Zephyr), applying
 * any active-low inversion and hysteresis required by the sensor. */
static bool s_demo_occupied = false;

void sensor_init(void) {
  s_demo_occupied = false;
}

int sensor_read(void) {
  s_demo_occupied = !s_demo_occupied; /* demo flicker until real GPIO is wired */
  return s_demo_occupied ? 1 : 0;
}

#endif
