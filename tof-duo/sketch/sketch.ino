#include <Wire.h>
#include <array>
#include <vl53l8cx.h>
#include <Arduino_RouterBridge.h>

// Wiring: SDA/SCL on dedicated header (Wire / i2c2), LPn=D7, VCC=3.3V
#define LPN_PIN 7

VL53L8CX sensor_tof(&Wire, LPN_PIN);

// Per-zone filter: keep readings alive. A zone with no usable reading holds its last
// value for HOLD_FRAMES, then goes empty. Noise is smoothed (EMA); real motion is followed fast.
static int16_t filt[64];
static uint8_t miss[64];
static const int JUMP_MM = 250;       // bigger change = real motion, jump straight to it
static const uint8_t HOLD_FRAMES = 8; // ~0.5 s at 15 Hz

// status 255 = no target; also reject zero/implausible distances
static inline bool zone_ok(uint8_t status, int16_t d) { return status != 255 && d > 0; }

static bool sensorUp = false;
static uint32_t lastFrameMs = 0, lastTryMs = 0;

static bool i2cPresent() { Wire.beginTransmission(0x29); return Wire.endTransmission() == 0; }

// (Re)start the sensor. Safe to call repeatedly: begin() pulses LPn, init() uploads the firmware.
static bool startSensor() {
  sensor_tof.begin();
  if (sensor_tof.init() != 0) return false;
  sensor_tof.set_resolution(VL53L8CX_RESOLUTION_8X8);
  sensor_tof.set_ranging_frequency_hz(15);
  sensor_tof.start_ranging();
  return true;
}

void setup() {
  Bridge.begin();
  Monitor.begin();
  Wire.begin();
  Wire.setClock(400000);

  pinMode(LPN_PIN, OUTPUT);
  digitalWrite(LPN_PIN, HIGH);

  Monitor.println(i2cPresent() ? "I2C 0x29: sensor found" : "I2C 0x29: NOT found (check SDA/SCL/3.3V/GND wiring)");
  Monitor.println("VL53L8CX init... (takes a few seconds)");
  sensorUp = startSensor();
  lastFrameMs = millis();
  Monitor.println(sensorUp ? "ranging started" : "init failed -> will keep retrying");
}

static uint32_t frames = 0, lastBeat = 0;

void loop() {
  if (millis() - lastBeat > 5000) {
    lastBeat = millis();
    Monitor.print("alive, up="); Monitor.print(sensorUp ? 1 : 0); Monitor.print(" frames="); Monitor.println(frames);
  }
  // Self-recovery: a loose I2C/power contact must not leave the sensor dead until the app is restarted.
  if (sensorUp && millis() - lastFrameMs > 3000) {
    Monitor.println("no data for 3 s -> sensor stalled, re-initialising");
    sensorUp = false; lastTryMs = 0;
  }
  if (!sensorUp) {
    if (millis() - lastTryMs > 2000) {
      lastTryMs = millis();
      Monitor.print("retry: I2C 0x29 "); Monitor.println(i2cPresent() ? "responds" : "NO RESPONSE (wiring/power?)");
      sensorUp = startSensor();
      if (sensorUp) { lastFrameMs = millis(); for (int i = 0; i < 64; i++) { filt[i] = 0; miss[i] = 0; } Monitor.println("sensor recovered"); }
    }
    delay(10);
    return;
  }
  uint8_t ready = 0;
  sensor_tof.check_data_ready(&ready);
  if (ready) {
    VL53L8CX_ResultsData r;
    sensor_tof.get_ranging_data(&r);

    std::array<int16_t, 64> zone_distances;
    int16_t min_d = INT16_MAX;
    for (int i = 0; i < 64; i++) {
      int idx = VL53L8CX_NB_TARGET_PER_ZONE * i;
      int16_t raw = r.distance_mm[idx];
      if (zone_ok(r.target_status[idx], raw)) {
        miss[i] = 0;
        if (filt[i] <= 0 || abs(raw - filt[i]) > JUMP_MM) filt[i] = raw;  // first sample / real motion
        else filt[i] = (filt[i] + raw) / 2;                                // EMA, alpha = 0.5
      } else if (miss[i] < HOLD_FRAMES) {
        miss[i]++;                                                         // hold last value
      } else {
        filt[i] = 0;                                                       // lost for good -> empty
      }
      zone_distances[i] = filt[i];
      if (filt[i] > 0 && filt[i] < min_d) min_d = filt[i];
    }
    frames++; lastFrameMs = millis();
    Bridge.notify("tof_zones", zone_distances);
    Bridge.notify("tof_min_distance", (float)(min_d == INT16_MAX ? 0 : min_d));
  }
  delay(10);
}
