# Hướng Dẫn Tích Hợp ESP32 với Hệ Thống MQTT

## 📡 Kiến Trúc Mới

```
ESP32 ←→ MQTT Broker (broker.emqx.io) ←→ Web Dashboard
         ↓
    Firebase (Chỉ lưu trữ lịch sử)
```

## 🔧 Cấu Hình MQTT

### Thông tin kết nối:
- **Broker**: `broker.emqx.io`
- **Port**: `1883` (cho ESP32)
- **WebSocket Port**: `8083` (cho Web)

### Topics:

#### 1. ESP32 → Web (Gửi dữ liệu sensor)
**Topic**: `DATALOGGER/{deviceId}/DATA`

**Payload** (JSON):
```json
{
  "temp": 27.5,
  "humid": 65,
  "lux": 850,
  "wifi_ssid": "YourWiFiName"
}
```

**Tần suất**: Theo `interval` được cấu hình (mặc định 30s)

#### 2. Web → ESP32 (Nhận lệnh điều khiển)
**Topic**: `DATALOGGER/{deviceId}/CMD`

**Các lệnh hỗ trợ**:

| Lệnh | Payload | Mô tả |
|------|---------|-------|
| START | `{"cmd":"START","val":""}` | Bật thiết bị, bắt đầu đo |
| STOP | `{"cmd":"STOP","val":""}` | Tắt thiết bị, dừng đo |
| FAN | `{"cmd":"FAN","val":"1"}` hoặc `{"cmd":"FAN","val":"0"}` | Bật/Tắt quạt |
| LAMP | `{"cmd":"LAMP","val":"1"}` hoặc `{"cmd":"LAMP","val":"0"}` | Bật/Tắt đèn |
| AC | `{"cmd":"AC","val":"1"}` hoặc `{"cmd":"AC","val":"0"}` | Bật/Tắt máy lạnh |

## 📝 Code Mẫu ESP32 (Arduino)

### 1. Cài đặt thư viện
```cpp
// Trong Arduino IDE: Library Manager
// - PubSubClient (by Nick O'Leary)
// - ArduinoJson (by Benoit Blanchon)
```

### 2. Code ESP32

```cpp
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <DHT.h>

// ========== CẤU HÌNH ==========
const char* ssid = "YOUR_WIFI_SSID";
const char* password = "YOUR_WIFI_PASSWORD";
const char* mqtt_server = "broker.emqx.io";
const int mqtt_port = 1883;
const char* deviceId = "esp32_01"; // ID thiết bị của bạn

// ========== CHÂN KẾT NỐI ==========
#define DHTPIN 4
#define DHTTYPE DHT22
#define LDR_PIN 34
#define FAN_PIN 25
#define LAMP_PIN 26
#define AC_PIN 27

// ========== ĐỐI TƯỢNG ==========
WiFiClient espClient;
PubSubClient client(espClient);
DHT dht(DHTPIN, DHTTYPE);

// ========== BIẾN TOÀN CỤC ==========
bool deviceActive = false;
bool fanActive = false;
bool lampActive = false;
bool acActive = false;
unsigned long lastSend = 0;
int sendInterval = 30000; // 30 giây

// ========== TOPICS ==========
String topicData = "DATALOGGER/" + String(deviceId) + "/DATA";
String topicCmd = "DATALOGGER/" + String(deviceId) + "/CMD";

// ========== KẾT NỐI WIFI ==========
void setup_wifi() {
  delay(10);
  Serial.println();
  Serial.print("Connecting to ");
  Serial.println(ssid);

  WiFi.begin(ssid, password);

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println("");
  Serial.println("WiFi connected");
  Serial.println("IP address: ");
  Serial.println(WiFi.localIP());
}

// ========== XỬ LÝ LỆNH MQTT ==========
void callback(char* topic, byte* payload, unsigned int length) {
  Serial.print("Message arrived [");
  Serial.print(topic);
  Serial.print("] ");
  
  String message = "";
  for (int i = 0; i < length; i++) {
    message += (char)payload[i];
  }
  Serial.println(message);

  // Parse JSON
  StaticJsonDocument<200> doc;
  DeserializationError error = deserializeJson(doc, message);
  
  if (error) {
    Serial.print("JSON parse failed: ");
    Serial.println(error.c_str());
    return;
  }

  String cmd = doc["cmd"];
  String val = doc["val"];

  // Xử lý lệnh
  if (cmd == "START") {
    deviceActive = true;
    Serial.println("Device STARTED");
  } 
  else if (cmd == "STOP") {
    deviceActive = false;
    fanActive = false;
    lampActive = false;
    acActive = false;
    digitalWrite(FAN_PIN, LOW);
    digitalWrite(LAMP_PIN, LOW);
    digitalWrite(AC_PIN, LOW);
    Serial.println("Device STOPPED");
  }
  else if (cmd == "FAN") {
    fanActive = (val == "1");
    digitalWrite(FAN_PIN, fanActive ? HIGH : LOW);
    Serial.println("Fan: " + String(fanActive ? "ON" : "OFF"));
  }
  else if (cmd == "LAMP") {
    lampActive = (val == "1");
    digitalWrite(LAMP_PIN, lampActive ? HIGH : LOW);
    Serial.println("Lamp: " + String(lampActive ? "ON" : "OFF"));
  }
  else if (cmd == "AC") {
    acActive = (val == "1");
    digitalWrite(AC_PIN, acActive ? HIGH : LOW);
    Serial.println("AC: " + String(acActive ? "ON" : "OFF"));
  }
}

// ========== KẾT NỐI MQTT ==========
void reconnect() {
  while (!client.connected()) {
    Serial.print("Attempting MQTT connection...");
    
    String clientId = "ESP32Client-" + String(deviceId);
    
    if (client.connect(clientId.c_str())) {
      Serial.println("connected");
      // Subscribe topic lệnh
      client.subscribe(topicCmd.c_str());
      Serial.println("Subscribed to: " + topicCmd);
    } else {
      Serial.print("failed, rc=");
      Serial.print(client.state());
      Serial.println(" try again in 5 seconds");
      delay(5000);
    }
  }
}

// ========== ĐỌC SENSOR ==========
void readAndSendSensorData() {
  if (!deviceActive) return;

  // Đọc DHT22
  float h = dht.readHumidity();
  float t = dht.readTemperature();

  // Đọc LDR
  int ldrValue = analogRead(LDR_PIN);
  int lux = map(ldrValue, 0, 4095, 0, 2000); // Chuyển đổi sang Lux

  // Kiểm tra dữ liệu hợp lệ
  if (isnan(h) || isnan(t)) {
    Serial.println("Failed to read from DHT sensor!");
    return;
  }

  // Tạo JSON
  StaticJsonDocument<200> doc;
  doc["temp"] = t;
  doc["humid"] = h;
  doc["lux"] = lux;
  doc["wifi_ssid"] = WiFi.SSID();

  String output;
  serializeJson(doc, output);

  // Gửi qua MQTT
  if (client.publish(topicData.c_str(), output.c_str())) {
    Serial.println("Data sent: " + output);
  } else {
    Serial.println("Failed to send data");
  }
}

// ========== SETUP ==========
void setup() {
  Serial.begin(115200);
  
  // Cấu hình chân
  pinMode(FAN_PIN, OUTPUT);
  pinMode(LAMP_PIN, OUTPUT);
  pinMode(AC_PIN, OUTPUT);
  pinMode(LDR_PIN, INPUT);
  
  digitalWrite(FAN_PIN, LOW);
  digitalWrite(LAMP_PIN, LOW);
  digitalWrite(AC_PIN, LOW);

  // Khởi động DHT
  dht.begin();

  // Kết nối WiFi
  setup_wifi();

  // Cấu hình MQTT
  client.setServer(mqtt_server, mqtt_port);
  client.setCallback(callback);
}

// ========== LOOP ==========
void loop() {
  // Đảm bảo kết nối MQTT
  if (!client.connected()) {
    reconnect();
  }
  client.loop();

  // Gửi dữ liệu theo chu kỳ
  unsigned long now = millis();
  if (now - lastSend > sendInterval) {
    lastSend = now;
    readAndSendSensorData();
  }
}
```

## 🔄 Luồng Hoạt Động

### 1. Khởi động ESP32
```
ESP32 → Kết nối WiFi
     → Kết nối MQTT Broker
     → Subscribe topic DATALOGGER/esp32_01/CMD
     → Đợi lệnh START
```

### 2. Khi nhận lệnh START từ Web
```
ESP32 ← Nhận {"cmd":"START","val":""}
     → Set deviceActive = true
     → Bắt đầu đọc sensor mỗi 30s
     → Publish dữ liệu lên DATALOGGER/esp32_01/DATA
```

### 3. Web nhận dữ liệu
```
Web ← Nhận data từ MQTT
    → Cập nhật Firebase (lưu trữ)
    → Cập nhật UI realtime
    → Vẽ biểu đồ
```

### 4. Khi user toggle switch trên Web
```
Web → Gửi {"cmd":"FAN","val":"1"} qua MQTT
ESP32 ← Nhận lệnh
     → digitalWrite(FAN_PIN, HIGH)
     → Cập nhật fanActive = true
```

## 🛠️ Cấu Hình Nâng Cao

### 1. Thay đổi Device ID
Trong Firebase, thêm device với ID tương ứng:
```
devices/
  └─ esp32_01/
      ├─ name: "Phòng Khách"
      ├─ active: false
      ├─ interval: 30
      └─ mode: "periodic"
```

### 2. Điều chỉnh chu kỳ gửi
ESP32 có thể đọc `interval` từ Firebase hoặc nhận qua MQTT:
```json
{"cmd":"INTERVAL","val":"10"}
```

Thêm vào hàm `callback()`:
```cpp
else if (cmd == "INTERVAL") {
  sendInterval = val.toInt() * 1000;
  Serial.println("Interval changed to: " + String(sendInterval));
}
```

## ⚠️ Lưu Ý Quan Trọng

1. **QoS Level**: Mặc định QoS 0 (at most once). Nếu cần đảm bảo gửi thành công, dùng QoS 1.

2. **Retained Messages**: Nếu muốn ESP32 nhận trạng thái khi mới kết nối, Web có thể gửi retained message:
```cpp
client.publish(topicCmd.c_str(), payload, true); // true = retained
```

3. **Xử lý mất kết nối**: Code đã có auto-reconnect. Nếu muốn lưu trạng thái, dùng EEPROM:
```cpp
#include <Preferences.h>
Preferences prefs;
prefs.begin("my-app", false);
prefs.putBool("fanActive", fanActive);
```

4. **Bảo mật**: Broker công cộng không có authentication. Nếu cần bảo mật, dùng:
   - MQTT over TLS (port 8883)
   - Username/Password authentication
   - Hoặc dùng broker riêng

## 🧪 Test & Debug

### 1. Test MQTT với MQTT.fx hoặc MQTTX
Subscribe topic:
```
DATALOGGER/+/DATA
DATALOGGER/+/CMD
```

### 2. Publish test command:
```
Topic: DATALOGGER/esp32_01/CMD
Payload: {"cmd":"FAN","val":"1"}
```

### 3. Check Serial Monitor:
```
Connecting to WiFi...
WiFi connected
IP address: 192.168.1.100
Attempting MQTT connection...connected
Subscribed to: DATALOGGER/esp32_01/CMD
Message arrived [DATALOGGER/esp32_01/CMD] {"cmd":"START","val":""}
Device STARTED
Data sent: {"temp":27.5,"humid":65,"lux":850,"wifi_ssid":"MyWiFi"}
```

## 📊 Firebase Structure (Chỉ lưu trữ)

```
devices/
  └─ esp32_01/
      ├─ name: "Phòng Khách"
      ├─ active: true
      ├─ temp: 27.5
      ├─ humid: 65
      ├─ lux: 850
      ├─ wifi_ssid: "MyWiFi"
      ├─ fan_active: true
      ├─ lamp_active: false
      ├─ ac_active: false
      ├─ interval: 30
      └─ last_update: 1734345600000

history/
  └─ esp32_01/
      ├─ -NxAbCdEfGh/
      │   ├─ temp: 27.5
      │   ├─ humid: 65
      │   ├─ lux: 850
      │   └─ last_update: 1734345600000
      └─ -NxAbCdEfGi/
          └─ ...
```

## 🎯 Lợi Ích Kiến Trúc Mới

✅ **Latency thấp**: MQTT trực tiếp, không qua Firebase  
✅ **Giảm chi phí**: Firebase chỉ lưu trữ, không realtime control  
✅ **Offline-capable**: ESP32 có thể cache lệnh  
✅ **Scalable**: Có thể thêm nhiều broker, load balancing  
✅ **Độc lập**: ESP32 không cần Firebase SDK  

## 🔗 Tài Liệu Tham Khảo

- [MQTT.org](https://mqtt.org/)
- [PubSubClient Library](https://github.com/knolleary/pubsubclient)
- [EMQX Broker](https://www.emqx.io/)
- [ArduinoJson](https://arduinojson.org/)
