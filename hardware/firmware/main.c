#include "hardware.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define WAITLESS_MAX_SAMPLES 128u

static void print_usage(const char *program) {
  printf("Usage: %s [--room OPD-1] [--script 1,1,0] [--debounce-ms 5000]\n", program);
  printf("Script values: 1/occupied, 0/vacant. One sample per virtual 5 seconds.\n");
}

#ifdef HOST_SIM
static size_t parse_script(const char *text, int *samples, size_t max) {
  size_t count = 0u;
  const char *cursor = text;
  while (*cursor != '\0' && count < max) {
    while (*cursor == ',' || *cursor == ' ') ++cursor;
    if (*cursor == '\0') break;

    if (*cursor == 'o' || *cursor == 'O' || *cursor == 'v' || *cursor == 'V') {
      samples[count++] = (*cursor == 'o' || *cursor == 'O') ? 1 : 0;
      while (*cursor != '\0' && *cursor != ',') ++cursor;
      continue;
    }

    char *end = NULL;
    long value = strtol(cursor, &end, 10);
    if (end == cursor) {
      ++cursor;
      continue;
    }
    samples[count++] = value != 0 ? 1 : 0;
    cursor = end;
  }
  return count;
}
#endif

int main(int argc, char **argv) {
  const char *room = WAITLESS_DEFAULT_ROOM;
  const char *script_text = "1,1,0,1,0";
  uint32_t debounce_ms = WAITLESS_DEFAULT_DEBOUNCE_MS;
  int samples[WAITLESS_MAX_SAMPLES];

  for (int i = 1; i < argc; ++i) {
    if (strcmp(argv[i], "--room") == 0 && i + 1 < argc) {
      room = argv[++i];
    } else if (strcmp(argv[i], "--script") == 0 && i + 1 < argc) {
      script_text = argv[++i];
    } else if (strcmp(argv[i], "--debounce-ms") == 0 && i + 1 < argc) {
      debounce_ms = (uint32_t)strtoul(argv[++i], NULL, 10);
    } else if (strcmp(argv[i], "--help") == 0) {
      print_usage(argv[0]);
      return 0;
    }
  }

  sensor_init();
  publisher_init(room);
#ifdef HOST_SIM
  const size_t count = parse_script(script_text, samples, WAITLESS_MAX_SAMPLES);
  sensor_load_script(samples, count);
  printf("[host-sim] room=%s samples=%u debounce_ms=%u\n", room, (unsigned int)count, (unsigned int)debounce_ms);
#else
  (void)samples;
  (void)script_text;
#endif

  int state = -1;
  int published_state = -1;
  bool seen = false;
  uint64_t state_since = 0u;
  uint64_t last_heartbeat = 0u;

  for (;;) {
    platform_tick();
    const int raw = sensor_read();
    const uint64_t now = platform_now_ms();

    if (raw >= 0 && raw != state) {
      state = raw;
      if (!seen) {
        state_since = now > debounce_ms ? now - debounce_ms : 0u;
        seen = true;
      } else {
        state_since = now;
      }
    }

    if (seen && state != published_state && now >= state_since + debounce_ms) {
      publisher_publish_occupancy(state ? "OCCUPIED" : "VACANT", publisher_next_seq());
      published_state = state;
    }

    if (last_heartbeat == 0u || now - last_heartbeat >= WAITLESS_HEARTBEAT_MS) {
      publisher_publish_heartbeat(publisher_next_seq());
      last_heartbeat = now;
    }

    platform_delay_ms(10u);
#ifdef HOST_SIM
    if (raw < 0) break; /* script exhausted */
#endif
  }

  return 0;
}
