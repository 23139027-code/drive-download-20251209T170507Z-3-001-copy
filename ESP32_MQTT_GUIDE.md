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

## ⚠️ Lưu Ý Quan Trọng & Troubleshooting

### 🔴 Vấn đề thường gặp:

#### 1. ESP32 kết nối MQTT thất bại

**Nguyên nhân:**
- ❌ Broker host/port sai → Kiểm tra Web Settings vs ESP32 code
- ❌ Broker yêu cầu auth nhưng không điền username/password
- ❌ Firewall chặn port 1883
- ❌ WiFi không ổn định

**Giải pháp:**
```cpp
// Trong reconnect(), thêm debug:
Serial.print("Connecting to: ");
Serial.print(mqtt_server);
Serial.print(":");
Serial.println(mqtt_port);

// Kiểm tra WiFi trước khi connect MQTT:
if (WiFi.status() != WL_CONNECTED) {
  Serial.println("WiFi disconnected! Reconnecting...");
  setup_wifi();
}
```

#### 2. Web không nhận data từ ESP32

**Nguyên nhân:**
- ❌ ESP32 chưa nhận lệnh START (deviceActive = false)
- ❌ Publish sai topic format
- ❌ JSON payload không đúng format
- ❌ Web subscribe sai broker

**Giải pháp:**
```cpp
// Debug trong readAndSendSensorData():
Serial.println("Publishing to: " + topicData);
Serial.println("Payload: " + output);
bool result = client.publish(topicData.c_str(), output.c_str());
Serial.println(result ? "✓ Sent" : "✗ Failed");
```

**Kiểm tra topic:**
- ESP32 publish: `DATALOGGER/esp32_01/DATA` ✓
- Web subscribe: `DATALOGGER/esp32_01/DATA` ✓
- Sai: `datalogger/esp32_01/data` ✗ (case sensitive!)

#### 3. ESP32 không nhận lệnh từ Web

**Nguyên nhân:**
- ❌ Chưa subscribe topic CMD
- ❌ Subscribe sai topic
- ❌ callback() không được gọi

**Giải pháp:**
```cpp
// Kiểm tra subscribe thành công:
if (client.subscribe(topicCmd.c_str())) {
  Serial.println("✓ Subscribed: " + topicCmd);
} else {
  Serial.println("✗ Subscribe failed!");
}

// Debug trong callback():
void callback(char* topic, byte* payload, unsigned int length) {
  Serial.println("\n=== MESSAGE RECEIVED ===");
  Serial.print("Topic: ");
  Serial.println(topic);
  Serial.print("Payload: ");
  for (int i = 0; i < length; i++) {
    Serial.print((char)payload[i]);
  }
  Serial.println("\n========================");
  // ... xử lý
}
```

#### 4. Sensor đọc sai giá trị

**DHT22 trả về NaN:**
```cpp
// Thêm delay sau khi đọc:
float h = dht.readHumidity();
delay(100);
float t = dht.readTemperature();

if (isnan(h) || isnan(t)) {
  Serial.println("✗ DHT read failed!");
  return;  // Không gửi data lỗi
}
```

**LDR đọc sai:**
```cpp
// Đọc nhiều lần và lấy trung bình:
int sum = 0;
for (int i = 0; i < 10; i++) {
  sum += analogRead(LDR_PIN);
  delay(10);
}
int ldrValue = sum / 10;
```

### 📋 Checklist Debug:

- [ ] WiFi connected (Serial hiển thị IP address)
- [ ] MQTT connected (Serial hiển thị "connected")
- [ ] Subscribe topic CMD thành công
- [ ] deviceActive = true (đã nhận START)
- [ ] Sensor đọc được giá trị (không NaN)
- [ ] JSON format đúng (dùng ArduinoJson)
- [ ] Topic format đúng (DATALOGGER/{id}/DATA)
- [ ] Web và ESP32 cùng broker
- [ ] Web Settings → Test Connection thành công

### 🔒 Bảo mật:

**1. QoS Level:**
```cpp
// QoS 0: At most once (mặc định)
client.publish(topic, payload);

// QoS 1: At least once (đảm bảo gửi)
client.publish(topic, payload, false, 1);
```

**2. Retained Messages:**
Nếu muốn Web nhận trạng thái ngay khi connect:
```cpp
// ESP32 gửi retained message:
client.publish(topicData.c_str(), output.c_str(), true);  // true = retained

// Message này sẽ được broker lưu lại
// Client mới subscribe sẽ nhận ngay message cuối
```

**3. Authentication:**
Nếu dùng broker riêng với username/password:
```cpp
const char* mqtt_user = "your_username";
const char* mqtt_pass = "your_password";

// Trong reconnect():
client.connect(clientId.c_str(), mqtt_user, mqtt_pass);
```

**4. SSL/TLS:**
Cho broker yêu cầu mã hóa:
```cpp
#include <WiFiClientSecure.h>
WiFiClientSecure espClient;
// ... cấu hình certificate
```

**5. Broker riêng:**
Tốt nhất là setup broker riêng (Mosquitto, EMQX) với:
- Username/Password
- SSL/TLS
- ACL (Access Control List)
- Rate limiting

## 🧪 Test & Debug

### 1. Kiểm tra cấu hình broker

**Trong Web Dashboard:**
1. Vào tab **Cấu hình** (Settings)
2. Xem thông tin broker hiện tại
3. Nhấn **Test Kết Nối** để đảm bảo Web kết nối được
4. Ghi chú: Host, Port, Username/Password (nếu có)

**Trong ESP32 Code:**
1. Mở file `.ino`
2. Kiểm tra các biến:
   ```cpp
   const char* mqtt_server = "???";  // ← Phải khớp Web
   const int mqtt_port = ???;        // ← 1883 cho ESP32
   const char* mqtt_user = "???";    // ← Nếu Web dùng
   const char* mqtt_pass = "???";    // ← Nếu Web dùng
   ```
3. Upload code và mở Serial Monitor (115200 baud)

### 2. Test MQTT với công cụ bên ngoài

**Dùng MQTTX (Khuyến nghị):**
- Download: https://mqttx.app/
- Kết nối cùng broker với Web
- Subscribe: `DATALOGGER/+/DATA` (nhận data từ ESP32)
- Subscribe: `DATALOGGER/+/CMD` (xem lệnh từ Web)
- Publish test: `DATALOGGER/esp32_01/CMD` → `{"cmd":"START","val":""}`

**Dùng MQTT.fx:**
- Download: https://mqttfx.jensd.de/
- Tương tự MQTTX

**Dùng mosquitto_sub/pub (Command line):**
```bash
# Subscribe (nhận data từ ESP32)
mosquitto_sub -h broker.emqx.io -p 1883 -t "DATALOGGER/+/DATA" -v

# Publish (gửi lệnh test đến ESP32)
mosquitto_pub -h broker.emqx.io -p 1883 -t "DATALOGGER/esp32_01/CMD" \
  -m '{"cmd":"START","val":""}'
```

### 3. Đọc Serial Monitor của ESP32

**Output mong đợi khi khởi động thành công:**
```
========================================
IoT System - ESP32 MQTT Client
========================================
Device ID: esp32_01
MQTT Broker: broker.emqx.io:1883

Connecting to WiFi: YourWiFiName
...........
✓ WiFi connected!
IP address: 192.168.1.100
Signal strength: -45 dBm

Attempting MQTT connection to broker.emqx.io:1883...
✓ Connected!
Client ID: ESP32Client-esp32_01-A3F2
✓ Subscribed to: DATALOGGER/esp32_01/CMD

System ready. Waiting for START command...
========================================

[10:23:45] Message received:
Topic: DATALOGGER/esp32_01/CMD
Payload: {"cmd":"START","val":""}
→ Device STARTED

[10:23:46] Reading sensors...
Temp: 27.5°C | Humidity: 65% | Light: 850 Lux
Publishing to: DATALOGGER/esp32_01/DATA
Payload: {"temp":27.5,"humid":65,"lux":850,"wifi_ssid":"YourWiFi"}
✓ Data sent successfully
```

**Nếu thấy lỗi:**
```
✗ MQTT connection failed, rc=-2
→ Kiểm tra: mqtt_server, mqtt_port
→ Đảm bảo khớp với Web Dashboard Settings
```

### 4. Kiểm tra trong Web Dashboard

**Các chỗ cần xem:**
1. **Header badges:**
   - `MQTT: Connected (broker.emqx.io)` ✓ Xanh
   - `Firebase: Connected` ✓ Xanh
   - `WiFi: YourWiFi` ✓ Xanh

2. **Tab Quản lý:**
   - Card thiết bị hiển thị đúng tên
   - Trạng thái: "Đang đo (30s)" khi active
   - Nhiệt độ, độ ẩm, ánh sáng cập nhật realtime

3. **Tab Dashboard:**
   - Click vào device → Modal chi tiết hiển thị
   - Biểu đồ vẽ được data
   - Toggle switches hoạt động (quạt, đèn, máy lạnh)

4. **Console Browser (F12):**
   ```javascript
   // Kiểm tra messages MQTT:
   MQTT Received: DATALOGGER/esp32_01/DATA {temp:27.5, humid:65, ...}
   ```

### 5. Test flow hoàn chỉnh

**Scenario 1: Bật thiết bị**
1. Web: Nhấn nút "Bật" trên card
2. Web Console: `MQTT Sent [DATALOGGER/esp32_01/CMD]: {"cmd":"START","val":""}`
3. ESP32 Serial: `Message received: {"cmd":"START","val":""}`
4. ESP32 Serial: `Device STARTED`
5. ESP32 Serial: `Data sent: {"temp":27.5,...}`
6. Web Console: `MQTT Received: ...`
7. Web: Card cập nhật trạng thái "Đang đo"

**Scenario 2: Toggle quạt**
1. Web: Mở chi tiết device → Bật switch Quạt
2. Web Console: `MQTT Sent: {"cmd":"FAN","val":"1"}`
3. ESP32 Serial: `Fan: ON`
4. ESP32: digitalWrite(FAN_PIN, HIGH)
5. Web: Switch giữ trạng thái ON

**Scenario 3: Xem biểu đồ**
1. Web: Tab Dashboard → Click device
2. Web: Hiển thị 20 điểm dữ liệu lịch sử từ Firebase
3. ESP32: Gửi data mới mỗi 30s
4. Web: Biểu đồ tự động cập nhật realtime

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

## 🎯 Lợi Ích Kiến Trúc MQTT

✅ **Latency thấp**: Điều khiển trực tiếp qua MQTT, không qua Firebase server  
✅ **Giảm chi phí Firebase**: Chỉ lưu trữ history, không dùng cho realtime control  
✅ **Offline-capable**: Broker có thể cache message khi ESP32 offline  
✅ **Scalable**: Dễ dàng thêm nhiều ESP32, không lo Firebase quota  
✅ **Độc lập**: ESP32 không cần Firebase SDK, chỉ cần MQTT  
✅ **Linh hoạt**: Có thể đổi broker bất cứ lúc nào qua Web Settings  
✅ **Realtime thực sự**: MQTT publish/subscribe nhanh hơn Firebase polling  

## 🆚 So Sánh: MQTT vs Firebase Direct

| Tiêu chí | MQTT (Hiện tại) | Firebase Direct (Cũ) |
|----------|-----------------|----------------------|
| Latency | 50-100ms | 200-500ms |
| Chi phí | $0 (broker free) | $25-50/tháng (nhiều thiết bị) |
| Bandwidth | Nhẹ (~100 bytes/msg) | Nặng (~1KB+ overhead) |
| Offline | Broker cache 24h | Không cache |
| Scalability | Hàng ngàn devices | Giới hạn connections |
| Setup | ESP32 đơn giản | ESP32 cần Firebase SDK |
| Flexibility | Đổi broker dễ | Khó đổi Firebase project |

## 🔗 Tài Liệu Tham Khảo

**MQTT:**
- [MQTT.org](https://mqtt.org/) - Giao thức MQTT chính thức
- [MQTT Explorer](http://mqtt-explorer.com/) - GUI tool để debug
- [HiveMQ MQTT Essentials](https://www.hivemq.com/mqtt-essentials/) - Tutorial chi tiết

**Libraries:**
- [PubSubClient](https://github.com/knolleary/pubsubclient) - MQTT cho ESP32
- [ArduinoJson](https://arduinojson.org/) - Parse JSON
- [Adafruit DHT](https://github.com/adafruit/DHT-sensor-library) - DHT22 sensor

**Brokers:**
- [EMQX](https://www.emqx.io/) - Broker mạnh nhất, hỗ trợ millions connections
- [Mosquitto](https://mosquitto.org/) - Lightweight, dễ self-host
- [HiveMQ](https://www.hivemq.com/) - Enterprise-grade

**Tools:**
- [MQTTX](https://mqttx.app/) - GUI client đẹp, đa nền tảng
- [MQTT.fx](https://mqttfx.jensd.de/) - Java-based client
- [mosquitto_pub/sub](https://mosquitto.org/man/mosquitto_pub-1.html) - Command line tools

**ESP32:**
- [ESP32 Arduino Core](https://github.com/espressif/arduino-esp32)
- [ESP32 MQTT Examples](https://github.com/espressif/esp-idf/tree/master/examples/protocols/mqtt)

## 📞 Hỗ Trợ & Troubleshooting

**Nếu gặp vấn đề:**

1. **Kiểm tra Serial Monitor** - 90% lỗi được báo ở đây
2. **Dùng MQTTX** - Test broker độc lập với ESP32
3. **So sánh config** - Web Settings vs ESP32 code phải khớp
4. **Test từng bước:**
   - WiFi OK? → Ping google.com
   - MQTT OK? → mosquitto_sub test
   - JSON OK? → Copy payload vào ArduinoJson Assistant
   - Topics OK? → Check case-sensitive, spelling

**Common errors và fix:**

| Error | Nguyên nhân | Giải pháp |
|-------|-------------|-----------|
| `rc=-2` | Không kết nối được broker | Check host/port, firewall |
| `rc=4` | Bad credentials | Check username/password |
| `rc=5` | Not authorized | Broker yêu cầu ACL |
| Data không gửi | Chưa START | Nhấn nút Bật trong Web |
| JSON parse fail | Sai format | Dùng ArduinoJson Assistant |
| Subscribe fail | Broker giới hạn | Dùng broker khác |

**Liên hệ:**
- GitHub Issues: [Repo này]
- Email: [Support email nếu có]
- Forum: [Link forum nếu có]

---

**🎓 Kết luận:**

Kiến trúc MQTT giúp hệ thống IoT của bạn:
- ⚡ Nhanh hơn
- 💰 Rẻ hơn  
- 🔧 Linh hoạt hơn
- 📈 Scale tốt hơn

Web Dashboard có thể đổi broker bất cứ lúc nào qua Settings.
ESP32 chỉ cần update code với broker tương ứng.

**Happy coding! 🚀**
