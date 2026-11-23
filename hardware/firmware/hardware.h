#ifndef WAITLESS_HARDWARE_H
#define WAITLESS_HARDWARE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Room codes must be simple (letters, digits, '-' or '_') because the host
 * publisher writes them straight into JSON. */
#define WAITLESS_DEFAULT_ROOM "OPD-1"
#define WAITLESS_DEFAULT_DEBOUNCE_MS 5000u
#define WAITLESS_HEARTBEAT_MS 30000u
#define WAITLESS_STEP_MS 5000u

/* Millisecond clock. HOST_SIM uses a deterministic virtual clock advanced by
 * platform_tick(); embedded builds should map this to board_millis()/Zephyr
 * k_uptime_get(). */
uint64_t platform_now_ms(void);
void platform_tick(void);
void platform_delay_ms(uint32_t ms);

/* Sensor returns 1 = occupied, 0 = vacant, -1 = no sample / end of host script. */
void sensor_init(void);
int sensor_read(void);
#ifdef HOST_SIM
void sensor_load_script(const int *samples, size_t count);
#endif

void publisher_init(const char *room_code);
uint32_t publisher_next_seq(void);
void publisher_publish_occupancy(const char *type, uint32_t seq);
void publisher_publish_heartbeat(uint32_t seq);

/* Writes a 64-character lowercase hex HMAC into out (at least 65 bytes).
 * Define WAITLESS_HMAC_MBEDTLS and provide DEVICE_HMAC_SECRET in secure
 * storage for real devices; host builds emit a placeholder signature. */
void sign_body(const char *body, char *out, size_t out_size);

#endif /* WAITLESS_HARDWARE_H */
