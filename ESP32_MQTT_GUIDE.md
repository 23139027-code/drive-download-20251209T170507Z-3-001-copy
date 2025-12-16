# Hướng Dẫn Tích Hợp ESP32 với Hệ Thống MQTT

## 📡 Kiến Trúc Hệ Thống

```
ESP32 ←→ MQTT Broker (Tùy chỉnh) ←→ Web Dashboard
         ↓
    Firebase (Chỉ lưu trữ lịch sử & authentication)
```

**Lưu ý quan trọng:** 
- Web Dashboard có thể cấu hình MQTT Broker khác nhau qua giao diện Settings
- ESP32 cần kết nối cùng broker mà Web đang dùng
- Mặc định: `broker.emqx.io:1883` (có thể thay đổi)

## 🔧 Cấu Hình MQTT

### ⚙️ Thông tin kết nối (Có thể thay đổi):

**QUAN TRỌNG:** Người dùng có thể thay đổi broker trong Web Dashboard (Tab Cấu hình)

**Mặc định:**
- **Broker Host**: `broker.emqx.io`
- **Port cho ESP32**: `1883` (MQTT standard)
- **Port cho Web**: `8083` (WebSocket)
- **SSL/TLS**: Không (có thể bật)
- **Username/Password**: Không (có thể thêm)

**Broker phổ biến khác:**
- HiveMQ: `broker.hivemq.com:1883`
- Eclipse Mosquitto: `test.mosquitto.org:1883`
- EMQX Public: `broker.emqx.io:1883`
- Broker riêng: `your-server.com:1883`

### 📨 Topics (KHÔNG thay đổi):

**Format Topics cố định** - Được hiển thị trong Web Dashboard:

#### 1. ESP32 → Web (Publish - Gửi dữ liệu sensor)
**Topic**: `DATALOGGER/{deviceId}/DATA`

**Ví dụ:** Nếu deviceId = `esp32_01` thì topic = `DATALOGGER/esp32_01/DATA`

**Payload** (JSON - Required):
```json
{
  "temp": 27.5,      // Nhiệt độ (°C)
  "humid": 65,       // Độ ẩm (%)
  "lux": 850,        // Ánh sáng (Lux)
  "wifi_ssid": "YourWiFiName"  // Tên WiFi đang kết nối
}
```

**Tần suất gửi**: 
- Theo `interval` được cấu hình trong Firebase (mặc định 30s)
- Chỉ gửi khi device đang active (đã nhận lệnh START)

#### 2. Web → ESP32 (Subscribe - Nhận lệnh điều khiển)
**Topic**: `DATALOGGER/{deviceId}/CMD`

**Ví dụ:** Subscribe `DATALOGGER/esp32_01/CMD` để nhận lệnh cho esp32_01

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
// - PubSubClient (by Nick O'Leary) - Version 2.8+
// - ArduinoJson (by Benoit Blanchon) - Version 6.x
// - DHT sensor library (by Adafruit) - Nếu dùng DHT22
```

### 2. Code ESP32 Đầy Đủ

```cpp
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <DHT.h>

// ========== CẤU HÌNH - THAY ĐỔI THEO HỆ THỐNG CỦA BẠN ==========

// WiFi
const char* ssid = "YOUR_WIFI_SSID";           // Tên WiFi
const char* password = "YOUR_WIFI_PASSWORD";   // Mật khẩu WiFi

// MQTT Broker - PHẢI KHỚP VỚI CẤU HÌNH TRONG WEB DASHBOARD
const char* mqtt_server = "broker.emqx.io";    // Host broker (xem trong Web Settings)
const int mqtt_port = 1883;                     // Port MQTT cho ESP32 (không phải WebSocket)
const char* mqtt_user = "";                     // Username (để trống nếu không cần)
const char* mqtt_pass = "";                     // Password (để trống nếu không cần)

// Device Info
const char* deviceId = "esp32_01";             // ID thiết bị - PHẢI KHỚP VỚI FIREBASE
                                                // Phải trùng với ID khi thêm device trong Web

// QUAN TRỌNG: 
// - Nếu Web dùng broker khác, cập nhật mqtt_server ở đây
// - Nếu broker yêu cầu auth, điền mqtt_user và mqtt_pass
// - deviceId phải giống với ID trong Firebase và Web Dashboard

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
    Serial.print("Attempting MQTT connection to ");
    Serial.print(mqtt_server);
    Serial.print(":");
    Serial.print(mqtt_port);
    Serial.print("...");
    
    String clientId = "ESP32Client-" + String(deviceId) + "-" + String(random(0xffff), HEX);
    
    // Kết nối với hoặc không có username/password
    bool connected = false;
    if (strlen(mqtt_user) > 0) {
      // Có authentication
      connected = client.connect(clientId.c_str(), mqtt_user, mqtt_pass);
    } else {
      // Không cần authentication
      connected = client.connect(clientId.c_str());
    }
    
    if (connected) {
      Serial.println("connected!");
      Serial.print("Client ID: ");
      Serial.println(clientId);
      
      // Subscribe topic lệnh
      if (client.subscribe(topicCmd.c_str())) {
        Serial.print("✓ Subscribed to: ");
        Serial.println(topicCmd);
      } else {
        Serial.println("✗ Failed to subscribe!");
      }
      
      // Gửi thông báo kết nối thành công
      StaticJsonDocument<100> doc;
      doc["status"] = "connected";
      doc["device"] = deviceId;
      String output;
      serializeJson(doc, output);
      client.publish(topicData.c_str(), output.c_str());
      
    } else {
      Serial.print("failed, rc=");
      Serial.print(client.state());
      Serial.print(" | Error: ");
      
      // Giải thích mã lỗi
      switch(client.state()) {
        case -4: Serial.println("Connection timeout"); break;
        case -3: Serial.println("Connection lost"); break;
        case -2: Serial.println("Connect failed"); break;
        case -1: Serial.println("Disconnected"); break;
        case  1: Serial.println("Bad protocol"); break;
        case  2: Serial.println("Bad client ID"); break;
        case  3: Serial.println("Unavailable"); break;
        case  4: Serial.println("Bad credentials"); break;
        case  5: Serial.println("Unauthorized"); break;
        default: Serial.println("Unknown error"); break;
      }
      
      Serial.println("→ Kiểm tra: mqtt_server, mqtt_port, mqtt_user, mqtt_pass");
      Serial.println("→ Đảm bảo khớp với cấu hình trong Web Dashboard (Tab Settings)");
      Serial.println("Retry in 5 seconds...");
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

## 🔄 Luồng Hoạt Động Chi Tiết

### 1. Khởi động ESP32
```
ESP32 → Kết nối WiFi
     → Kết nối MQTT Broker (theo cấu hình trong code)
     → Subscribe topic DATALOGGER/{deviceId}/CMD
     → Gửi message "connected" để báo đã online
     → Chờ lệnh START từ Web Dashboard
     → (deviceActive = false, không gửi data)
```

**Lưu ý:** ESP32 phải kết nối đúng broker mà Web đang dùng!

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

### 1. Đồng bộ Broker giữa Web và ESP32

**QUAN TRỌNG:** Web và ESP32 PHẢI dùng cùng MQTT Broker!

**Cách kiểm tra broker đang dùng:**

1. **Trong Web Dashboard:**
   - Vào tab **Cấu hình** (Settings)
   - Xem phần "Cấu hình MQTT Broker"
   - Ghi chú: Host, Port, Username/Password (nếu có)

2. **Trong ESP32 Code:**
   - Cập nhật các biến:
   ```cpp
   const char* mqtt_server = "broker.emqx.io";  // ← Phải khớp với Web
   const int mqtt_port = 1883;                   // ← Port cho ESP32
   const char* mqtt_user = "";                   // ← Username (nếu Web dùng)
   const char* mqtt_pass = "";                   // ← Password (nếu Web dùng)
   ```

3. **Test kết nối:**
   - Trong Web: Nhấn nút "Test Kết Nối" trong Settings
   - Trong ESP32: Xem Serial Monitor khi khởi động
   - Cả hai phải hiển thị "Connected" với cùng broker

**Ví dụ các broker phổ biến:**

| Broker | Host | Port ESP32 | Port Web | SSL | Auth |
|--------|------|------------|----------|-----|------|
| EMQX Public | broker.emqx.io | 1883 | 8083 | ✗ | ✗ |
| HiveMQ Public | broker.hivemq.com | 1883 | 8000 | ✗ | ✗ |
| Mosquitto Test | test.mosquitto.org | 1883 | 8080 | ✗ | ✗ |
| EMQX SSL | broker.emqx.io | 8883 | 8084 | ✓ | ✗ |
| Private Broker | your-server.com | 1883 | 8083 | ? | ✓ |

### 2. Thay đổi Device ID

**Bước 1:** Chọn Device ID duy nhất (ví dụ: `esp32_living_room`)

**Bước 2:** Cập nhật trong ESP32:
```cpp
const char* deviceId = "esp32_living_room";  // ← ID mới
```

**Bước 3:** Trong Web Dashboard:
- Vào tab **Quản lý**
- Nhấn **Thêm Thiết Bị**
- Nhập **Device ID**: `esp32_living_room`
- Nhập tên: "Phòng Khách"
- Chọn interval: 30s
- Lưu

**Bước 4:** ESP32 sẽ tự động:
- Subscribe `DATALOGGER/esp32_living_room/CMD`
- Publish `DATALOGGER/esp32_living_room/DATA`

Firebase structure:
```
devices/
  └─ esp32_living_room/
      ├─ name: "Phòng Khách"
      ├─ active: false
      ├─ interval: 30
      ├─ fan_active: false
      ├─ lamp_active: false
      └─ ac_active: false
```

### 3. Sử dụng SSL/TLS (Bảo mật cao hơn)

Nếu Web Dashboard cấu hình dùng SSL:

**Thay đổi trong ESP32:**
```cpp
#include <WiFiClientSecure.h>

WiFiClientSecure espClient;  // ← Thay WiFiClient
PubSubClient client(espClient);

void setup() {
  // ...
  espClient.setInsecure();  // ← Bỏ qua verify certificate (cho test)
  // Hoặc dùng certificate thật:
  // espClient.setCACert(ca_cert);
  
  client.setServer(mqtt_server, 8883);  // ← Port SSL (8883 thay vì 1883)
  // ...
}
```

**Cảnh báo:** setInsecure() không an toàn cho production!

### 4. Điều chỉnh chu kỳ gửi động

ESP32 có thể nhận lệnh thay đổi interval từ Web:

**Thêm vào hàm `callback()`:**
```cpp
else if (cmd == "INTERVAL") {
  int newInterval = val.toInt();
  if (newInterval >= 5 && newInterval <= 300) {  // 5s-5min
    sendInterval = newInterval * 1000;
    Serial.println("✓ Interval changed to: " + String(newInterval) + "s");
  } else {
    Serial.println("✗ Invalid interval: " + val);
  }
}
```

**Web có thể gửi:**
```json
{"cmd":"INTERVAL","val":"10"}
```

### 5. Lưu trạng thái vào EEPROM/Preferences

Để ESP32 nhớ trạng thái sau khi reset:

```cpp
#include <Preferences.h>

Preferences prefs;

void setup() {
  prefs.begin("iot-app", false);
  
  // Đọc trạng thái cũ
  deviceActive = prefs.getBool("active", false);
  fanActive = prefs.getBool("fan", false);
  lampActive = prefs.getBool("lamp", false);
  acActive = prefs.getBool("ac", false);
  
  // Khôi phục output pins
  digitalWrite(FAN_PIN, fanActive ? HIGH : LOW);
  digitalWrite(LAMP_PIN, lampActive ? HIGH : LOW);
  digitalWrite(AC_PIN, acActive ? HIGH : LOW);
}

void callback(...) {
  // Sau khi xử lý lệnh, lưu lại
  if (cmd == "START") {
    deviceActive = true;
    prefs.putBool("active", true);
  }
  else if (cmd == "FAN") {
    fanActive = (val == "1");
    prefs.putBool("fan", fanActive);
    // ...
  }
  // Tương tự cho LAMP, AC
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
