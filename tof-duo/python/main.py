"""tof-duo (MQTT version): publish my ToF frames to a broker and subscribe to the team's frames.

Topics (<team> = shared team code, <name> = board/player name):
  tofduo/<team>/<name>/frame   {"zones":[64 mm], "seq":int, "ts":epoch_ms, "name":str}   QoS0
  tofduo/<team>/<name>/status  "online" | "offline" (retained, offline is also the last-will)
  tofduo/<team>/<name>/cmd     commands from the hub (e.g. {"led":"..."}), subscribed by this board
"""
import json
import os
import re
import threading
import time

import paho.mqtt.client as mqtt

from arduino.app_utils import App, Bridge, Logger
from arduino.app_bricks.web_ui import WebUI

logger = Logger("tof-duo")
ui = WebUI()

PUBLISH_INTERVAL = 0.1   # 10 Hz
PEER_TIMEOUT = 3.0       # no frame for this long -> peer offline

CONFIG_PATH = "/app/data/config.json"   # /app is bind-mounted from ~/ArduinoApps/tof-duo, so this survives restarts (git-ignored)

lock = threading.Lock()
cfg = {
    "broker": os.environ.get("MQTT_BROKER", "broker.hivemq.com"),
    "port": int(os.environ.get("MQTT_PORT", "1883")),
    "team": os.environ.get("TEAM_CODE", ""),
    "name": os.environ.get("BOARD_NAME", ""),
    "label": os.environ.get("BOARD_LABEL", ""),   # display name shown in the UI (any language)
}


def load_config():
    """Saved settings (team code, id, display name, broker) override the env defaults after a restart."""
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            saved = json.load(f)
        for k in ("broker", "team", "name", "label"):
            if isinstance(saved.get(k), str) and saved[k]:
                cfg[k] = saved[k]
        if isinstance(saved.get("port"), int):
            cfg["port"] = saved["port"]
        logger.info(f"loaded saved config: team='{cfg['team']}' name='{cfg['name']}'")
    except FileNotFoundError:
        pass
    except Exception as e:
        logger.warning(f"could not read {CONFIG_PATH}: {e}")


def save_config():
    try:
        os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False)
    except Exception as e:
        logger.warning(f"could not save config: {e}")


st = {"local": None, "local_ts": 0.0, "tx_seq": 0, "tx_ok": 0, "connected": False}
peers = {}   # name -> {"zones", "last", "seq", "lost", "count", "times", "ts"}
client = None


def clean(s):
    """MQTT-topic-safe name: letters, digits, '_' and '-' only."""
    return re.sub(r"[^A-Za-z0-9_-]", "", str(s))[:24]


def base():
    return f"tofduo/{cfg['team']}"


# ---------------- sensor -> UI ----------------
def on_tof_zones(zones):
    zones = list(zones)
    with lock:
        st["local"], st["local_ts"] = zones, time.time()
    ui.send_message("local_zones", {"zones": zones})


Bridge.provide("tof_zones", on_tof_zones)
Bridge.provide("tof_min_distance", lambda d: None)


# ---------------- MQTT ----------------
def on_connect(c, userdata, flags, rc, props=None):
    ok = (rc == 0) if isinstance(rc, int) else not rc.is_failure
    with lock:
        st["connected"] = ok
    if not ok:
        logger.warning(f"MQTT connect failed: {rc}")
        return
    logger.info(f"MQTT connected to {cfg['broker']}:{cfg['port']} team='{cfg['team']}'")
    c.subscribe([(f"{base()}/+/frame", 0), (f"{base()}/+/status", 0), (f"{base()}/{cfg['name']}/cmd", 0)])
    c.publish(f"{base()}/{cfg['name']}/status", "online", qos=1, retain=True)


def on_disconnect(c, userdata, *args):
    with lock:
        st["connected"] = False


def on_message(c, userdata, msg):
    try:
        _, _, who, kind = msg.topic.split("/", 3)
    except ValueError:
        return
    if kind == "cmd":
        ui.send_message("cmd", {"payload": msg.payload.decode(errors="ignore")})
        return
    if who == cfg["name"]:
        return  # my own message echoed back
    if kind == "status":
        with lock:
            p = peers.setdefault(who, {"zones": None, "last": 0, "seq": None, "lost": 0, "count": 0, "times": [], "ts": 0})
            p["declared"] = msg.payload.decode(errors="ignore")
        return
    try:
        d = json.loads(msg.payload)
        zones = d["zones"]
        assert isinstance(zones, list) and len(zones) == 64
    except Exception:
        return
    now = time.time()
    with lock:
        p = peers.setdefault(who, {"zones": None, "last": 0, "seq": None, "lost": 0, "count": 0, "times": [], "ts": 0})
        seq = d.get("seq")
        if isinstance(seq, int):
            if p["seq"] is not None and seq > p["seq"] + 1:
                p["lost"] += seq - p["seq"] - 1
            p["seq"] = seq
        p["zones"], p["last"], p["ts"] = zones, now, d.get("ts", 0)
        p["label"] = str(d.get("label", ""))[:24]
        p["count"] += 1
        p["times"] = [t for t in p["times"] if now - t < 2.0] + [now]
    ui.send_message("peer_zones", {"name": who, "label": peers[who].get("label", ""), "zones": zones})


def connect():
    """(Re)create the MQTT client from cfg. Called at start and when the UI changes settings."""
    global client
    if client is not None:
        try:
            client.publish(f"{base()}/{cfg['name']}/status", "offline", qos=1, retain=True)
            client.loop_stop(); client.disconnect()
        except Exception:
            pass
        client = None
    with lock:
        st["connected"] = False
        peers.clear()
        st["tx_ok"] = 0
    if not cfg["team"] or not cfg["name"]:
        return
    c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"tofduo-{cfg['team']}-{cfg['name']}-{os.getpid()}")
    c.on_connect, c.on_disconnect, c.on_message = on_connect, on_disconnect, on_message
    c.will_set(f"{base()}/{cfg['name']}/status", "offline", qos=1, retain=True)
    c.reconnect_delay_set(1, 10)
    try:
        c.connect_async(cfg["broker"], cfg["port"], keepalive=15)
        c.loop_start()
        client = c
    except Exception as e:
        logger.warning(f"MQTT start failed: {e}")


def set_config(payload: dict):
    """POST /set_config {team, name, broker?, port?} - change settings from the web UI."""
    team, name = clean(payload.get("team", "")), clean(payload.get("name", ""))
    if not team or not name:
        return {"ok": False, "error": "team and name are required (A-Z a-z 0-9 _ -)"}
    cfg.update(team=team, name=name, label=str(payload.get("label", "")).strip()[:24])
    if payload.get("broker"):
        cfg["broker"] = str(payload["broker"]).strip()
    if payload.get("port"):
        cfg["port"] = int(payload["port"])
    save_config()
    connect()
    return {"ok": True, **cfg}


ui.expose_api("POST", "/set_config", set_config)


def reset(payload: dict):
    """POST /reset : forget all received frames/peers and counters (frame reset button in the UI)."""
    with lock:
        peers.clear()
        st["tx_ok"] = 0
        st["local"] = None
    return {"ok": True}


ui.expose_api("POST", "/reset", reset)
ui.expose_api("GET", "/state", lambda: dict(cfg))


# ---------------- publish loop ----------------
def publisher():
    while True:
        time.sleep(PUBLISH_INTERVAL)
        with lock:
            frame, ok = st["local"], st["connected"]
            # never re-send a stale frame: if the sensor stalls, stop publishing so peers see "no response"
            if client is None or not ok or frame is None or time.time() - st["local_ts"] > 1.0:
                continue
            st["tx_seq"] += 1
            body = json.dumps({"zones": frame, "seq": st["tx_seq"], "ts": int(time.time() * 1000), "name": cfg["name"], "label": cfg["label"]})
        try:
            client.publish(f"{base()}/{cfg['name']}/frame", body, qos=0)
            with lock:
                st["tx_ok"] += 1
        except Exception:
            pass


def status_loop():
    while True:
        time.sleep(1.0)
        now = time.time()
        with lock:
            plist = []
            for n, p in peers.items():
                total = p["count"] + p["lost"]
                plist.append({
                    "name": n,
                    "label": p.get("label", ""),
                    "alive": p["last"] > 0 and (now - p["last"]) < PEER_TIMEOUT,
                    "fps": round(len([t for t in p["times"] if now - t < 2.0]) / 2.0, 1),
                    "loss_pct": round(100.0 * p["lost"] / total, 1) if total else 0.0,
                    "age_ms": int((time.time() * 1000) - p["ts"]) if p["ts"] else None,
                })
            s = {"team": cfg["team"], "name": cfg["name"], "label": cfg["label"], "broker": cfg["broker"],
                 "mqtt": st["connected"], "tx_ok": st["tx_ok"], "peers": plist,
                 "sensor_ok": (time.time() - st["local_ts"]) < 2.0}
        ui.send_message("status", s)


load_config()
threading.Thread(target=publisher, daemon=True).start()
threading.Thread(target=status_loop, daemon=True).start()
connect()
App.run()
