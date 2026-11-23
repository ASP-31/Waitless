#include "hardware.h"

#include <stdio.h>
#include <string.h>

#ifdef WAITLESS_HMAC_MBEDTLS
#include <mbedtls/md.h>
#endif

#ifndef DEVICE_HMAC_SECRET
#define DEVICE_HMAC_SECRET "dev-device-secret-change-me"
#endif

static char s_room[64] = WAITLESS_DEFAULT_ROOM;
static uint32_t s_seq = 0u;

void publisher_init(const char *room_code) {
  snprintf(s_room, sizeof(s_room), "%s", room_code ? room_code : WAITLESS_DEFAULT_ROOM);
  s_seq = 0u;
}

uint32_t publisher_next_seq(void) {
  s_seq += 1u;
  return s_seq;
}

void sign_body(const char *body, char *out, size_t out_size) {
  if (out_size < 65u) return;
  out[0] = '\0';
#ifdef WAITLESS_HMAC_MBEDTLS
  const unsigned char key[] = DEVICE_HMAC_SECRET;
  unsigned char digest[32] = {0};
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  if (mbedtls_md_setup(&ctx, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 1) == 0 &&
      mbedtls_md_hmac_starts(&ctx, key, sizeof(key) - 1u) == 0 &&
      mbedtls_md_hmac_update(&ctx, (const unsigned char *)body, strlen(body)) == 0 &&
      mbedtls_md_hmac_finish(&ctx, digest) == 0) {
    for (size_t i = 0u; i < sizeof(digest); ++i) {
      snprintf(out + (i * 2u), 3u, "%02x", digest[i]);
    }
  } else {
    snprintf(out, out_size, "%064d", 0);
  }
  mbedtls_md_free(&ctx);
#else
  (void)body;
  /* Host/lab builds only: the backend will reject this signature. Wire
   * mbedTLS (or a secure element) before deploying to a real room. */
  snprintf(out, out_size, "%064d", 0);
#endif
}

static void build_body(char *buffer, size_t size, const char *type, uint32_t seq) {
  snprintf(buffer, size,
           "{\"v\":1,\"roomId\":\"%s\",\"type\":\"%s\",\"ts\":%llu,\"seq\":%u}",
           s_room, type, (unsigned long long)platform_now_ms(), (unsigned int)seq);
}

static void emit(const char *suffix, const char *body, const char *sig) {
#ifdef HOST_SIM
  printf("{\"topic\":\"waitless/rooms/%s/%s\",\"payload\":%s,\"sig\":\"%s\"}\n", s_room, suffix, body, sig);
#else
  /* Replace with the chosen network stack's MQTT publish call. The topic and
   * body are ready for `waitless/rooms/{room}/{occupancy|heartbeat}`. */
  printf("[mqtt] waitless/rooms/%s/%s %s sig=%s\n", s_room, suffix, body, sig);
#endif
}

void publisher_publish_occupancy(const char *type, uint32_t seq) {
  char body[256];
  char sig[65];
  build_body(body, sizeof(body), type, seq);
  sign_body(body, sig, sizeof(sig));
  emit("occupancy", body, sig);
}

void publisher_publish_heartbeat(uint32_t seq) {
  char body[256];
  char sig[65];
  build_body(body, sizeof(body), "HEARTBEAT", seq);
  sign_body(body, sig, sizeof(sig));
  emit("heartbeat", body, sig);
}
