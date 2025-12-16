// script.js
import { db, auth } from './firebase-config.js'; // Import cấu hình chung
import { requireAuth, logout } from './auth.js'; // Import hàm tiện ích
import { ref, onValue, set, update, get, push, remove, query, limitToLast, orderByChild, equalTo } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

// --- 1. KHAI BÁO BIẾN TOÀN CỤC (BẮT BUỘC) ---
let myChartInstance = null;      // Biến giữ biểu đồ
let currentChartType = null;     // Loại biểu đồ đang chọn
let currentReportDeviceId = null; // ID thiết bị đang xem báo cáo
// Biến lưu dữ liệu lịch sử để vẽ
let cachedHistoryData = { labels: [], temps: [], humids: [], lights: [] };
// 1. Kiểm tra Login ngay lập tức
requireAuth();

// --- CẤU HÌNH MQTT ---
// Load cấu hình MQTT từ localStorage hoặc dùng mặc định
function loadMQTTConfig() {
    const savedConfig = localStorage.getItem('mqtt_config');
    if (savedConfig) {
        try {
            const config = JSON.parse(savedConfig);
            return {
                host: config.host || "broker.emqx.io",
                port: config.port || 8083,
                path: config.path || "/mqtt",
                useSSL: config.useSSL || false,
                username: config.username || "",
                password: config.password || "",
                keepalive: config.keepalive || 60,
                reconnect: config.reconnect !== false,
                clientId: "WebDashboard_" + Math.random().toString(16).substr(2, 8)
            };
        } catch (e) {
            console.error("Lỗi load MQTT config:", e);
        }
    }
    // Cấu hình mặc định
    return {
        host: "broker.emqx.io",
        port: 8083,
        path: "/mqtt",
        useSSL: false,
        username: "",
        password: "",
        keepalive: 60,
        reconnect: true,
        clientId: "WebDashboard_" + Math.random().toString(16).substr(2, 8)
    };
}

const mqttConfig = loadMQTTConfig();
let mqttClient;
let subscribedDevices = new Set(); // Track các thiết bị đã subscribe

document.addEventListener('DOMContentLoaded', () => {
    // 2. Gán sự kiện Logout
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            if (confirm("Bạn có chắc muốn đăng xuất?")) {
                logout().then(() => window.location.href = 'login.html');
            }
        });
    }

    const sidebar = document.getElementById('sidebar');
    const mainContent = document.querySelector('.main-content');
    const toggleBtn = document.getElementById('sidebar-toggle');

    if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
            // Toggle class 'collapsed' cho sidebar
            sidebar.classList.toggle('collapsed');

            // Toggle class 'expanded' cho nội dung chính
            mainContent.classList.toggle('expanded');
        });
    }

    // Kết nối Firebase & MQTT
    updateStatus('db-status', 'warning', 'Firebase: Connecting...');
    initFirebaseApp();
    connectMQTT();

    // Setup các chức năng khác
    setupModal();
    setupEditModal();
    setupMasterSwitch();
});
//--- Kiểm tra kết nối Firebase để cập nhật trạng thái ---
function monitorConnection() {
    const statusBadge = document.getElementById('db-status');
    // .info/connected là đường dẫn đặc biệt của Firebase để check kết nối
    const connectedRef = ref(db, ".info/connected");

    onValue(connectedRef, (snap) => {
        if (snap.val() === true) {
            statusBadge.textContent = "Firebase: Connected";
            statusBadge.className = "badge success"; // Màu xanh
        } else {
            statusBadge.textContent = "Firebase: Disconnected";
            statusBadge.className = "badge error";   // Màu đỏ
        }
    });
}

// --- CÁC HÀM MQTT ---
function connectMQTT() {
    try {
        mqttClient = new Paho.MQTT.Client(mqttConfig.host, mqttConfig.port, mqttConfig.path, mqttConfig.clientId);
        
        // Handler khi mất kết nối
        mqttClient.onConnectionLost = (obj) => {
            console.log("MQTT Lost:", obj.errorMessage);
            updateStatus('mqtt-status', 'error', 'MQTT: Lost');
            subscribedDevices.clear(); // Clear danh sách subscribe
        };
        
        // Handler nhận message từ ESP32
        mqttClient.onMessageArrived = (message) => {
            handleMQTTMessage(message);
        };
        
        // Tạo connect options từ config
        const connectOptions = {
            onSuccess: () => {
                console.log("MQTT Connected to", mqttConfig.host);
                updateStatus('mqtt-status', 'success', `MQTT: Connected (${mqttConfig.host})`);
                // Subscribe các topic từ devices hiện có
                subscribeToAllDevices();
            },
            onFailure: (e) => {
                console.log("MQTT Fail", e);
                updateStatus('mqtt-status', 'error', 'MQTT: Failed');
            },
            useSSL: mqttConfig.useSSL,
            keepAliveInterval: mqttConfig.keepalive,
            reconnect: mqttConfig.reconnect,
            timeout: 10
        };
        
        // Thêm username/password nếu có
        if (mqttConfig.username) {
            connectOptions.userName = mqttConfig.username;
            connectOptions.password = mqttConfig.password;
        }
        
        mqttClient.connect(connectOptions);
    } catch (e) {
        console.error("Lỗi khởi tạo MQTT:", e);
    }
}

// Hàm kiểm tra MQTT connected
function isMQTTConnected() {
    let connected = false;
    try {
        if (!mqttClient) connected = false;
        else if (typeof mqttClient.isConnected === 'function') connected = mqttClient.isConnected();
        else if (typeof mqttClient.isConnected !== 'function' && mqttClient.isConnected !== undefined) connected = !!mqttClient.isConnected;
        else if (mqttClient.connected !== undefined) connected = !!mqttClient.connected;
    } catch (e) {
        connected = false;
    }
    return connected;
}

// Subscribe tất cả devices khi kết nối MQTT
async function subscribeToAllDevices() {
    try {
        const snapshot = await get(ref(db, 'devices'));
        if (snapshot.exists()) {
            const devices = snapshot.val();
            Object.keys(devices).forEach(deviceId => {
                subscribeDevice(deviceId);
            });
        }
    } catch (err) {
        console.error("Lỗi subscribe devices:", err);
    }
}

// Subscribe 1 device cụ thể
function subscribeDevice(deviceId) {
    if (!isMQTTConnected()) return;
    
    const topic = `DATALOGGER/${deviceId}/DATA`;
    
    if (!subscribedDevices.has(deviceId)) {
        try {
            mqttClient.subscribe(topic);
            subscribedDevices.add(deviceId);
            console.log(`Subscribed to: ${topic}`);
        } catch (e) {
            console.error(`Lỗi subscribe ${topic}:`, e);
        }
    }
}

// Xử lý message MQTT nhận được từ ESP32
function handleMQTTMessage(message) {
    try {
        const topic = message.destinationName;
        const payload = JSON.parse(message.payloadString);
        
        console.log("MQTT Received:", topic, payload);
        
        // Extract deviceId từ topic: DATALOGGER/{deviceId}/DATA
        const parts = topic.split('/');
        if (parts.length >= 3 && parts[0] === 'DATALOGGER' && parts[2] === 'DATA') {
            const deviceId = parts[1];
            
            // Cập nhật dữ liệu lên Firebase để lưu trữ lịch sử
            updateFirebaseFromMQTT(deviceId, payload);
        }
    } catch (err) {
        console.error("Lỗi xử lý MQTT message:", err);
    }
}

// Cập nhật dữ liệu từ MQTT lên Firebase (chỉ để lưu trữ)
async function updateFirebaseFromMQTT(deviceId, payload) {
    try {
        const updates = {
            last_update: Date.now()
        };
        
        // Lưu các giá trị sensor nếu có
        if (payload.temp !== undefined) updates.temp = payload.temp;
        if (payload.humid !== undefined) updates.humid = payload.humid;
        if (payload.lux !== undefined) updates.lux = payload.lux;
        if (payload.wifi_ssid !== undefined) updates.wifi_ssid = payload.wifi_ssid;
        
        // Cập nhật vào devices
        await update(ref(db, `devices/${deviceId}`), updates);
        
        // Lưu vào history nếu có đủ dữ liệu sensor
        if (payload.temp !== undefined && payload.humid !== undefined && payload.lux !== undefined) {
            const historyData = {
                temp: payload.temp,
                humid: payload.humid,
                lux: payload.lux,
                last_update: Date.now()
            };
            await push(ref(db, `history/${deviceId}`), historyData);
        }
    } catch (err) {
        console.error("Lỗi cập nhật Firebase:", err);
    }
}

// Gửi lệnh điều khiển qua MQTT
function sendCommand(deviceId, cmd, val = "") {
    if (!isMQTTConnected()) {
        alert("Chưa kết nối MQTT! Không thể gửi lệnh.");
        return false;
    }

    const topic = `DATALOGGER/${deviceId}/CMD`;
    const payload = JSON.stringify({ cmd: cmd, val: val });
    const message = new Paho.MQTT.Message(payload);
    message.destinationName = topic;
    
    try {
        mqttClient.send(message);
        console.log(`MQTT Sent [${topic}]:`, payload);
        return true;
    } catch (e) {
        console.error("Lỗi gửi MQTT:", e);
        return false;
    }
}

// --- CÁC HÀM FIREBASE ---
function initFirebaseApp() {
    const devicesRef = ref(db, 'devices');
    onValue(devicesRef, (snapshot) => {
        updateStatus('db-status', 'success', 'Firebase: Connected');
        const data = snapshot.val();
        renderGrid(data || {}); // Xử lý trường hợp data null
        
        // Cập nhật trạng thái WiFi từ thiết bị đầu tiên có dữ liệu
        updateWiFiStatus(data);
    });
}

// Hàm cập nhật trạng thái WiFi
function updateWiFiStatus(devicesData) {
    if (!devicesData) {
        updateStatus('wifi-status', 'error', 'WiFi: Không kết nối');
        return;
    }
    
    // Lấy thiết bị đầu tiên có wifi_ssid
    let wifiFound = false;
    for (const deviceId in devicesData) {
        const device = devicesData[deviceId];
        if (device && device.wifi_ssid) {
            updateStatus('wifi-status', 'success', `WiFi: ${device.wifi_ssid}`);
            wifiFound = true;
            break;
        }
    }
    
    if (!wifiFound) {
        updateStatus('wifi-status', 'warning', 'WiFi: Không kết nối');
    }
}

// Hàm render 
function renderGrid(data) {
    const grid = document.getElementById('device-grid');
    const addBtn = document.getElementById('btn-open-modal');

    // Xóa card cũ, giữ lại nút Add
    const cards = grid.querySelectorAll('.card:not(#btn-open-modal)');
    cards.forEach(card => card.remove());

    Object.keys(data).forEach(deviceId => {
        const device = data[deviceId];
        if (!device || !device.name) return;


        const card = document.createElement('div');
        card.className = 'card';

        // Header
        const header = document.createElement('div');
        header.className = 'card-header';
        const headerLeft = document.createElement('div');
        const titleDiv = document.createElement('div');
        titleDiv.className = 'card-title';
        titleDiv.textContent = device.name;
        const idSpan = document.createElement('span');
        idSpan.className = 'device-id';
        idSpan.textContent = deviceId;
        headerLeft.appendChild(titleDiv);
        headerLeft.appendChild(idSpan);
        const chipIcon = document.createElement('i');
        chipIcon.className = 'fa-solid fa-microchip';
        chipIcon.style.color = '#6b7280';
        header.appendChild(headerLeft);
        header.appendChild(chipIcon);

        // Status row
        const statusRow = document.createElement('div');
        statusRow.style.marginBottom = '10px';
        const statusDot = document.createElement('span');
        statusDot.className = 'status-dot';
        const isActive = !!device.active;
        const statusColor = isActive ? '#10b981' : '#9ca3af';
        statusDot.style.background = statusColor;
        const statusText = document.createElement('span');
        statusText.className = 'status-text';
        statusText.style.color = statusColor;
        statusText.textContent = isActive ? `Đang đo (${device.interval || 30}s)` : 'Đã tắt';
        statusRow.appendChild(statusDot);
        statusRow.appendChild(statusText);

        // Metrics
        const metrics = document.createElement('div');
        metrics.className = 'metrics';

        const makeMetric = (label, value) => {
            const item = document.createElement('div');
            item.className = 'metric-item';
            const lbl = document.createElement('span'); lbl.className = 'metric-label'; lbl.textContent = label;
            const val = document.createElement('span'); val.className = 'metric-value'; val.textContent = value;
            item.appendChild(lbl); item.appendChild(val);
            return item;
        };

        metrics.appendChild(makeMetric('NHIỆT ĐỘ', (device.temp !== undefined ? device.temp : '--') + '°C'));
        metrics.appendChild(makeMetric('ĐỘ ẨM', (device.humid !== undefined ? device.humid : '--') + '%'));
        metrics.appendChild(makeMetric('ÁNH SÁNG', (device.lux !== undefined ? device.lux : '--') + ' Lux'));

        // Actions
        const actions = document.createElement('div');
        actions.className = 'card-actions';

        const btnEdit = document.createElement('button');
        btnEdit.className = 'btn-sm';
        btnEdit.textContent = 'Sửa';
        btnEdit.addEventListener('click', () => window.triggerEdit(deviceId, device.name, device.interval || 30));

        const btnPower = document.createElement('button');
        const powerClass = isActive ? 'btn-warning' : 'btn-success';
        btnPower.className = `btn-sm ${powerClass}`;
        btnPower.innerHTML = isActive ? '<i class="fa-solid fa-power-off"></i> Tắt' : '<i class="fa-solid fa-play"></i> Bật';
        btnPower.addEventListener('click', () => window.toggleDevice(deviceId, isActive));

        actions.appendChild(btnEdit);
        actions.appendChild(btnPower);

        // Compose card
        card.appendChild(header);
        card.appendChild(statusRow);
        card.appendChild(metrics);
        card.appendChild(actions);

        grid.insertBefore(card, addBtn);
    });
}

// --- HÀM XỬ LÝ SỬA & XÓA ---
let currentEditId = null;
// 1. Hàm được gọi khi nhấn nút "Sửa" trên Card
window.triggerEdit = (id, currentName, currentInterval) => {
    currentEditId = id; // Lưu ID vào biến toàn cục

    // Điền dữ liệu cũ vào form
    document.getElementById('edit-dev-id').value = id;
    document.getElementById('edit-dev-name').value = currentName;
    document.getElementById('edit-dev-interval').value = currentInterval;

    // Hiện Modal Sửa
    document.getElementById('edit-modal').style.display = 'block';
};


// Setup logic cho Modal Sửa (gọi hàm này trong DOMContentLoaded)
function setupEditModal() {
    const editModal = document.getElementById('edit-modal');
    const editForm = document.getElementById('edit-form');
    const closeBtn = document.querySelector('.closeBtn');
    const deleteBtn = document.getElementById('btn-delete-device');

    // Đóng modal khi nhấn X
    if (closeBtn) {
        closeBtn.onclick = () => {
            editModal.style.display = "none";
            currentEditId = null;
        };
    }

    // Xử lý LƯU (Cập nhật tên)
    if (editForm) {
        editForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const newName = document.getElementById('edit-dev-name').value;
            const newInterval = parseInt(document.getElementById('edit-dev-interval').value);

            if (currentEditId && newName && newInterval) {
                try {
                    // Cập nhật lên Firebase
                    await update(ref(db, `devices/${currentEditId}`), {
                        name: newName,
                        interval: newInterval
                    });
                    alert("Cập nhật thành công!");
                    editModal.style.display = "none";
                } catch (err) {
                    alert("Lỗi cập nhật: " + err.message);
                }
            }
        });
    }

    // Xử lý XÓA (Xóa khỏi Firebase)
    if (deleteBtn) {
        deleteBtn.addEventListener('click', async () => {
            if (!currentEditId) return;

            const confirmMsg = `CẢNH BÁO: Bạn có chắc chắn muốn xóa thiết bị [${currentEditId}]?\nDữ liệu sẽ bị xóa VĨNH VIỄN khỏi hệ thống.`;
            if (confirm(confirmMsg)) {
                try {
                    // Xóa node trên Firebase
                    await remove(ref(db, `devices/${currentEditId}`));

                    alert("Đã xóa thiết bị thành công!");
                    editModal.style.display = "none";
                    currentEditId = null;
                    // UI sẽ tự cập nhật nhờ hàm onValue lắng nghe Firebase
                } catch (err) {
                    alert("Lỗi xóa: " + err.message);
                }
            }
        });
    }

    // Đóng modal khi click ra ngoài vùng trắng
    window.addEventListener('click', (e) => {
        if (e.target == editModal) {
            editModal.style.display = "none";
        }
    });
}


// --- MODAL & SWITCH ---
function setupModal() {
    const modal = document.getElementById('add-modal');
    const btn = document.getElementById('btn-open-modal');
    const span = document.querySelector('.close');
    const form = document.getElementById('add-form');


    if (btn) btn.onclick = () => modal.style.display = "block";
    if (span) span.onclick = () => modal.style.display = "none";
    window.addEventListener('click', (e) => { if (e.target == modal) modal.style.display = "none"; });

    if (form) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const name = document.getElementById('dev-name').value;
            const id = document.getElementById('dev-id').value;
            // Lấy giá trị chu kỳ từ form thêm mới
            const interval = parseInt(document.getElementById('dev-interval').value) || 30;

            const deviceConfig = {
                name: name,
                active: true,
                mode: 'periodic', // Mặc định là chế độ tự động đo
                interval: interval // Lưu chu kỳ vào Firebase
            };

            try {
                // Lưu vào Firebase
                await update(ref(db, `devices/${id}`), deviceConfig);
                
                // Subscribe MQTT cho device mới
                subscribeDevice(id);
                
                // Gửi lệnh START qua MQTT để kích hoạt device
                sendCommand(id, 'START');
                
                alert("Thêm thiết bị thành công!");
                modal.style.display = "none";
                form.reset();
            } catch (err) {
                alert("Lỗi: " + err.message);
            }
        });
    }
}

function setupMasterSwitch() {
    const btn = document.getElementById('master-switch');
    if (!btn) return;

    // 1. Xử lý khi nhấn nút (DÙNG MQTT)
    btn.addEventListener('click', async () => {
        // Kiểm tra xem nút đang ở trạng thái nào (dựa vào class)
        // Nếu đang có class 'is-on' nghĩa là hệ thống đang chạy -> Cần TẮT (false)
        const isSystemRunning = btn.classList.contains('is-on');
        const targetState = !isSystemRunning; // Đảo ngược trạng thái mong muốn

        try {
            // Lấy danh sách tất cả thiết bị từ Firebase về
            const snapshot = await get(ref(db, 'devices'));

            if (snapshot.exists()) {
                const devices = snapshot.val();
                const updates = {};
                const cmd = targetState ? 'START' : 'STOP';

                // Gửi lệnh MQTT cho TẤT CẢ thiết bị
                Object.keys(devices).forEach(key => {
                    sendCommand(key, cmd);
                    
                    // Nếu tắt hệ thống, tắt luôn các thiết bị con
                    if (!targetState) {
                        sendCommand(key, 'FAN', '0');
                        sendCommand(key, 'LAMP', '0');
                        sendCommand(key, 'AC', '0');
                    }
                    
                    // Cập nhật Firebase để đồng bộ UI
                    updates[`devices/${key}/active`] = targetState;
                    if (!targetState) {
                        updates[`devices/${key}/fan_active`] = false;
                        updates[`devices/${key}/lamp_active`] = false;
                        updates[`devices/${key}/ac_active`] = false;
                    }
                });

                // Gửi 1 lệnh duy nhất lên Firebase (Atomic Update)
                await update(ref(db), updates);

                // Cập nhật giao diện nút ngay lập tức
                updateMasterButtonUI(targetState);
            }
        } catch (err) {
            alert("Lỗi thao tác hệ thống: " + err.message);
        }
    });

    // 2. Hàm cập nhật giao diện nút Master
    function updateMasterButtonUI(isOn) {
        if (isOn) {
            // Trạng thái: Hệ thống đang BẬT -> Hiện nút để TẮT
            btn.className = 'master-btn is-on';
            btn.innerHTML = '<i class="fa-solid fa-power-off"></i> <span>TẮT TOÀN BỘ HỆ THỐNG</span>';
            btn.style.backgroundColor = '#dc2626'; // Đỏ
        } else {
            // Trạng thái: Hệ thống đang TẮT -> Hiện nút để BẬT LẠI
            btn.className = 'master-btn is-off';
            btn.innerHTML = '<i class="fa-solid fa-play"></i> <span>BẬT LẠI HỆ THỐNG</span>';
            btn.style.backgroundColor = '#10b981'; // Xanh lá
        }
    }

    // 3. (Tùy chọn) Kiểm tra trạng thái ban đầu khi tải trang
    // Đoạn này giúp nút hiển thị đúng trạng thái thực tế khi vừa vào web
    get(ref(db, 'devices')).then(snapshot => {
        if (snapshot.exists()) {
            const devices = snapshot.val();
            // Nếu tìm thấy ít nhất 1 thiết bị đang chạy -> Coi như hệ thống đang bật
            const isAnyOn = Object.values(devices).some(d => d.active === true);
            updateMasterButtonUI(isAnyOn);
        }
    });
}

function updateStatus(id, type, text) {
    const el = document.getElementById(id);
    if (el) {
        el.className = `badge ${type}`;
        el.innerText = text;
    }
}

// Hàm Bật/Tắt thiết bị từ xa (DÙNG MQTT)
window.toggleDevice = async (id, currentStatus) => {
    try {
        // Đảo ngược trạng thái hiện tại (Đang bật -> tắt, Đang tắt -> bật)
        const newStatus = !currentStatus;

        // Gửi lệnh qua MQTT
        const cmd = newStatus ? 'START' : 'STOP';
        const success = sendCommand(id, cmd);
        
        if (!success) {
            alert("Không thể gửi lệnh qua MQTT!");
            return;
        }

        // Cập nhật trạng thái vào Firebase (để đồng bộ UI)
        const updates = {
            active: newStatus
        };

        // Nếu hành động là TẮT NGUỒN thì tắt luôn toàn bộ các công tắc con
        if (newStatus === false) {
            updates.fan_active = false;    // Tắt quạt
            updates.lamp_active = false;   // Tắt đèn
            updates.ac_active = false;     // Tắt điều hòa
            
            // Gửi lệnh tắt các thiết bị con qua MQTT
            sendCommand(id, 'FAN', '0');
            sendCommand(id, 'LAMP', '0');
            sendCommand(id, 'AC', '0');
        }

        // Cập nhật Firebase để đồng bộ UI
        await update(ref(db, `devices/${id}`), updates);

    } catch (err) {
        alert("Lỗi cập nhật trạng thái: " + err.message);
    }
};

//  Hàm chuyển đổi Tab (Dashboard <-> Báo cáo)
window.switchTab = function (tabName) {
    const dashboardGrid = document.getElementById('device-grid');
    const addBtn = document.getElementById('btn-open-modal');
    const reportTitleView = document.getElementById('report-view');
    const reportList = document.getElementById('report-list');
    const reportDetail = document.getElementById('report-detail');
    const masterBtn = document.getElementById('master-switch');
    const mainHeaderTitle = document.querySelector('header h1');
    const settingView = document.getElementById('setting-view');
    const exportView = document.getElementById('export-view');

    document.querySelectorAll('.sidebar .menu a').forEach(a => a.classList.remove('active'));

    if (dashboardGrid) dashboardGrid.style.display = 'none';
    if (addBtn) addBtn.style.display = 'none';
    if (reportTitleView) reportTitleView.style.display = 'none';
    if (reportList) reportList.style.display = 'none';
    if (reportDetail) reportDetail.style.display = 'none';
    if (settingView) settingView.style.display = 'none';
    if (exportView) exportView.style.display = 'none';

    if (tabName === 'dashboard') {
        if (dashboardGrid) dashboardGrid.style.display = 'grid';
        if (addBtn) addBtn.style.display = 'block';
        if (masterBtn) masterBtn.style.display = 'flex';
        if (mainHeaderTitle) mainHeaderTitle.innerText = 'Quản lý các phòng';
        updateActiveMenu(0);

    } else if (tabName === 'report') {
        if (reportTitleView) reportTitleView.style.display = 'block';
        if (reportList) reportList.style.display = 'grid';
        if (masterBtn) masterBtn.style.display = 'none';
        if (mainHeaderTitle) mainHeaderTitle.innerText = 'Báo Cáo & Phân Tích';

        if (typeof renderReportList === 'function') renderReportList();

        updateActiveMenu(1);
    } else if (tabName === 'setting') {
        if (settingView) settingView.style.display = 'block';
        if (masterBtn) masterBtn.style.display = 'none';
        if (mainHeaderTitle) mainHeaderTitle.innerText = 'Cấu Hình Hệ Thống';

        loadSettingsToForm();
        updateActiveMenu(3);
    } else if (tabName === 'export') {
        if (exportView) exportView.style.display = 'block';
        if (masterBtn) masterBtn.style.display = 'none';
        if (mainHeaderTitle) mainHeaderTitle.innerText = 'Dữ Liệu Tổng Hợp';
        updateActiveMenu(2);
    }
}

// Hàm phụ để đổi màu cho menu sidebar
function updateActiveMenu(index) {
    const links = document.querySelectorAll('.sidebar .menu a');
    links.forEach(link => link.classList.remove('active'));
    if (links[index]) links[index].classList.add('active');
}

// --- 3. LOGIC BIỂU ĐỒ & BÁO CÁO (QUAN TRỌNG) ---

// Render danh sách phòng ở trang Báo Cáo với REALTIME UPDATE
function renderReportList() {
    const grid = document.getElementById('report-list');
    if (!grid) return;
    grid.innerHTML = '<p style="color:#666">Đang tải dữ liệu...</p>';

    // SỬA: Dùng onValue thay vì get để cập nhật realtime
    onValue(ref(db, 'devices'), (snapshot) => {
        grid.innerHTML = '';

        if (snapshot.exists()) {
            const data = snapshot.val();
            Object.keys(data).forEach(deviceId => {
                const device = data[deviceId];
                if (!device || !device.name) return;

                const card = document.createElement('div');
                card.className = 'report-card';
                card.setAttribute('data-device-id', deviceId); // Thêm ID để dễ update

                // Header
                const header = document.createElement('div');
                header.className = 'card-header';
                const headerLeft = document.createElement('div');
                const titleDiv = document.createElement('div');
                titleDiv.className = 'card-title';
                titleDiv.textContent = device.name;
                const idSpan = document.createElement('span');
                idSpan.className = 'device-id';
                idSpan.textContent = deviceId;
                headerLeft.appendChild(titleDiv);
                headerLeft.appendChild(idSpan);
                const chipIcon = document.createElement('i');
                chipIcon.className = 'fa-solid fa-microchip';
                chipIcon.style.color = '#6b7280';
                header.appendChild(headerLeft);
                header.appendChild(chipIcon);

                // Status row
                const statusRow = document.createElement('div');
                statusRow.style.marginBottom = '10px';
                const statusDot = document.createElement('span');
                statusDot.className = 'status-dot';
                const isActive = !!device.active;
                const statusColor = isActive ? '#10b981' : '#9ca3af';
                statusDot.style.background = statusColor;
                const statusText = document.createElement('span');
                statusText.className = 'status-text';
                statusText.style.color = statusColor;
                statusText.textContent = isActive ? `Đang đo (${device.interval || 30}s)` : 'Đã tắt';
                statusRow.appendChild(statusDot);
                statusRow.appendChild(statusText);

                // Metrics
                const metrics = document.createElement('div');
                metrics.className = 'metrics';

                const makeMetric = (label, value) => {
                    const item = document.createElement('div');
                    item.className = 'metric-item';
                    const lbl = document.createElement('span');
                    lbl.className = 'metric-label';
                    lbl.textContent = label;
                    const val = document.createElement('span');
                    val.className = 'metric-value';
                    val.textContent = value;
                    item.appendChild(lbl);
                    item.appendChild(val);
                    return item;
                };

                metrics.appendChild(makeMetric('NHIỆT ĐỘ', (device.temp !== undefined ? device.temp : '--') + '°C'));
                metrics.appendChild(makeMetric('ĐỘ ẨM', (device.humid !== undefined ? device.humid : '--') + '%'));
                metrics.appendChild(makeMetric('ÁNH SÁNG', (device.lux !== undefined ? device.lux : '--') + ' Lux'));

                // Actions
                const actions = document.createElement('div');
                actions.className = 'card-actions';

                const btnDetail = document.createElement('button');
                btnDetail.className = 'btn-sm btn-primary';
                btnDetail.style.width = '100%';
                btnDetail.innerHTML = '<i class="fa-solid fa-chart-line"></i> Xem Chi Tiết';
                btnDetail.addEventListener('click', () => {
                    showChart(deviceId, device.name);
                });

                actions.appendChild(btnDetail);

                // Compose card
                card.appendChild(header);
                card.appendChild(statusRow);
                card.appendChild(metrics);
                card.appendChild(actions);

                // Add click listener to card AFTER all elements are appended
                // Check if click is on button or button child to prevent opening chart
                card.addEventListener('click', (e) => {
                    // If clicked element or its parent is a button, don't open chart
                    if (e.target.tagName === 'BUTTON' || e.target.closest('button')) {
                        return;
                    }
                    showChart(deviceId, device.name);
                });

                grid.appendChild(card);
            });
        } else {
            grid.innerHTML = '<p>Chưa có thiết bị nào.</p>';
        }
    }, (err) => {
        console.error(err);
        grid.innerHTML = '<p style="color:#ef4444">Lỗi tải dữ liệu</p>';
    });
}

// Hàm chọn loại biểu đồ (Gắn vào window để HTML gọi)
window.selectChartType = (type) => {
    console.log("Click chọn biểu đồ:", type);
    currentChartType = type;
    updateChartUIActive(type);
    drawChartNewLogic();
};

function updateChartUIActive(type) {
    const ids = ['btn-chart-temp', 'btn-chart-humid', 'btn-chart-light'];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('active-chart');
    });

    if (type === 'temp') document.getElementById('btn-chart-temp')?.classList.add('active-chart');
    if (type === 'humid') document.getElementById('btn-chart-humid')?.classList.add('active-chart');
    if (type === 'light') document.getElementById('btn-chart-light')?.classList.add('active-chart');
}

// Hàm hiển thị Chi tiết & Lấy dữ liệu
async function showChart(deviceId, deviceName) {
    console.log("Mở biểu đồ:", deviceName);
    currentReportDeviceId = deviceId;

    // 1. Reset & Chuẩn bị giao diện
    updateChartUIActive(null); // Reset nút bấm
    document.getElementById('report-detail').style.display = 'block';

    // Cập nhật tên phòng
    const title = document.getElementById('report-title'); // Hoặc id là 'chart-device-name' tùy HTML của bạn
    if (title) title.innerText = `Phòng: ${deviceName}`;

    // Cuộn xuống
    document.getElementById('report-detail').scrollIntoView({ behavior: 'smooth' });

    // 2. Tải lịch sử CŨ (Chỉ tải 1 lần duy nhất để làm nền)
    cachedHistoryData = { labels: [], temps: [], humids: [], lights: [] };

    try {
        const historyRef = query(ref(db, `history/${deviceId}`), limitToLast(20));
        const historySnapshot = await get(historyRef); // Dùng get thay vì onValue

        if (historySnapshot.exists()) {
            historySnapshot.forEach(child => {
                const val = child.val();
                const timeStr = new Date(val.last_update).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                cachedHistoryData.labels.push(timeStr);
                cachedHistoryData.temps.push(val.temp);
                cachedHistoryData.humids.push(val.humid);
                cachedHistoryData.lights.push(val.lux);
            });
        }
    } catch (e) {
        console.error("Lỗi tải lịch sử:", e);
    }

    // Vẽ biểu đồ lần đầu (với dữ liệu lịch sử vừa tải)
    drawChartNewLogic();

    // 3. LẮNG NGHE REALTIME (Quan trọng nhất)
    // Nghe đúng cái chỗ mà 3 ô số liệu đang nghe
    let lastSensorData = { temp: null, humid: null, light: null }; // Track previous sensor values

    onValue(ref(db, `devices/${deviceId}`), (snapshot) => {
        const data = snapshot.val();
        if (!data) return;

        // Nguồn
        const elPower = document.getElementById('detail-power-status');
        const elBoxPower = document.getElementById('stat-power-box');
        if (elPower && elBoxPower) {
            if (data.active) {
                elPower.innerText = "ĐANG BẬT"; elPower.style.color = "#10b981"; elBoxPower.style.borderLeftColor = "#10b981";
                elBoxPower.onclick = () => window.toggleDevice(deviceId, true);
            } else {
                elPower.innerText = "ĐÃ TẮT"; elPower.style.color = "#ef4444"; elBoxPower.style.borderLeftColor = "#ef4444";
                elBoxPower.onclick = () => window.toggleDevice(deviceId, false);
            }
        }
        // 3 thông số
        if (document.getElementById('detail-temp')) document.getElementById('detail-temp').innerText = (data.temp || '--') + ' °C';
        if (document.getElementById('detail-humid')) document.getElementById('detail-humid').innerText = (data.humid || '--') + ' %';
        if (document.getElementById('detail-light')) document.getElementById('detail-light').innerText = (data.lux || '--') + ' Lux';

        // Switch
        if (document.getElementById('toggle-fan')) document.getElementById('toggle-fan').checked = (data.fan_active === true);
        if (document.getElementById('toggle-lamp')) document.getElementById('toggle-lamp').checked = (data.lamp_active === true);
        if (document.getElementById('toggle-ac')) document.getElementById('toggle-ac').checked = (data.ac_active === true);


        // --- B. CẬP NHẬT BIỂU ĐỒ - CHỈ KHI DỮ LIỆU SENSOR THAY ĐỔI ---
        // Check if sensor data actually changed (not just toggle changes)
        const sensorChanged =
            lastSensorData.temp !== data.temp ||
            lastSensorData.humid !== data.humid ||
            lastSensorData.light !== data.lux;

        if (sensorChanged && data.temp !== undefined && data.humid !== undefined && data.lux !== undefined) {
            // Update last known sensor values
            lastSensorData = { temp: data.temp, humid: data.humid, light: data.lux };

            // Lấy giờ hiện tại
            const now = new Date();
            const timeLabel = now.getHours() + ':' + String(now.getMinutes()).padStart(2, '0') + ':' + String(now.getSeconds()).padStart(2, '0');

            // Đẩy số liệu mới đang nhảy vào mảng biểu đồ
            cachedHistoryData.labels.push(timeLabel);
            cachedHistoryData.temps.push(data.temp || 0);
            cachedHistoryData.humids.push(data.humid || 0);
            cachedHistoryData.lights.push(data.lux || 0);

            // Cắt bớt nếu dài quá (giữ 20 điểm)
            if (cachedHistoryData.labels.length > 20) {
                cachedHistoryData.labels.shift();
                cachedHistoryData.temps.shift();
                cachedHistoryData.humids.shift();
                cachedHistoryData.lights.shift();
            }

            // Gọi hàm cập nhật biểu đồ (Update nhẹ)
            updateChartRealtime();
        }
    });
}

function updateChartRealtime() {
    // Nếu chưa có biểu đồ hoặc chưa chọn loại dữ liệu thì thôi
    if (!myChartInstance || !currentChartType) return;

    // Cập nhật trục thời gian
    myChartInstance.data.labels = cachedHistoryData.labels;

    // Cập nhật đường kẻ tùy theo tab đang chọn
    if (currentChartType === 'temp') {
        myChartInstance.data.datasets[0].data = cachedHistoryData.temps;
    } else if (currentChartType === 'humid') {
        myChartInstance.data.datasets[0].data = cachedHistoryData.humids;
    } else if (currentChartType === 'light') {
        myChartInstance.data.datasets[0].data = cachedHistoryData.lights;
    }

    // Vẽ lại (chế độ 'none' để không chạy lại animation từ đầu -> mượt)
    myChartInstance.update('none');
}


// Hàm vẽ biểu đồ (Safe Mode)
function drawChartNewLogic() {
    const canvas = document.getElementById('myChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    // Hủy biểu đồ cũ nếu có
    if (myChartInstance) {
        myChartInstance.destroy();
        myChartInstance = null;
    }

    let labelsToDraw = cachedHistoryData.labels;
    // Nếu chưa có dữ liệu nào thì tạo mảng rỗng để không lỗi
    if (!labelsToDraw || labelsToDraw.length === 0) {
        labelsToDraw = ["--", "--", "--", "--", "--"];
    }

    let dataToDraw = [];
    let labelText = "Chọn thông số";
    let color = "#ccc";
    let unit = "";

    // Nếu chưa chọn gì thì vẽ đường 0
    if (!currentChartType) {
        dataToDraw = new Array(labelsToDraw.length).fill(0);
    } else {
        // Lấy toàn bộ mảng lịch sử hiện có ra vẽ
        if (currentChartType === 'temp') {
            dataToDraw = cachedHistoryData.temps;
            labelText = "Nhiệt Độ (°C)"; color = "#f97316"; unit = "°C";
        } else if (currentChartType === 'humid') {
            dataToDraw = cachedHistoryData.humids;
            labelText = "Độ Ẩm (%)"; color = "#3b82f6"; unit = "%";
        } else if (currentChartType === 'light') {
            dataToDraw = cachedHistoryData.lights;
            labelText = "Ánh Sáng (Lux)"; color = "#eab308"; unit = " Lux";
        }

        // Fix lỗi nếu mảng data ngắn hơn mảng label (do mới khởi tạo)
        if (dataToDraw.length < labelsToDraw.length) {
            const diff = labelsToDraw.length - dataToDraw.length;
            for (let i = 0; i < diff; i++) dataToDraw.push(0);
        }
    }

    myChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labelsToDraw,
            datasets: [{
                label: labelText,
                data: dataToDraw,
                borderColor: color,
                backgroundColor: color + "33",
                tension: 0.4,
                fill: true,
                pointRadius: currentChartType ? 4 : 0,
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            scales: {
                y: {
                    beginAtZero: true,
                    title: { display: !!unit, text: unit }
                },
                x: { display: false } // Ẩn trục X
            }
        }
    });
}

// Hàm xử lý 3 nút gạt Quick Control (DÙNG MQTT)
window.toggleFeature = async (feature) => {
    if (!currentReportDeviceId) return;

    // Lấy trạng thái hiện tại của checkbox
    let isChecked = false;
    let dbKey = '';
    let mqttCmd = '';

    if (feature === 'fan') {
        isChecked = document.getElementById('toggle-fan').checked;
        dbKey = 'fan_active';
        mqttCmd = 'FAN';
    } else if (feature === 'lamp') {
        isChecked = document.getElementById('toggle-lamp').checked;
        dbKey = 'lamp_active';
        mqttCmd = 'LAMP';
    } else if (feature === 'ac') {
        isChecked = document.getElementById('toggle-ac').checked;
        dbKey = 'ac_active';
        mqttCmd = 'AC';
    }

    try {
        // Gửi lệnh qua MQTT
        const mqttVal = isChecked ? '1' : '0';
        const success = sendCommand(currentReportDeviceId, mqttCmd, mqttVal);
        
        if (!success) {
            // Nếu MQTT fail, trả lại trạng thái cũ
            document.getElementById(`toggle-${feature}`).checked = !isChecked;
            alert("Không thể gửi lệnh qua MQTT!");
            return;
        }
        
        // Cập nhật Firebase để đồng bộ UI
        await update(ref(db, `devices/${currentReportDeviceId}`), {
            [dbKey]: isChecked
        });
        
    } catch (err) {
        console.error("Lỗi toggle:", err);
        // Nếu lỗi thì trả lại trạng thái cũ cho checkbox
        document.getElementById(`toggle-${feature}`).checked = !isChecked;
    }
};
window.closeReportDetail = () => {
    document.getElementById('report-detail').style.display = 'none';
};

// Đóng modal báo cáo khi click ra vùng ngoài (overlay)
window.addEventListener('click', (e) => {
    const reportModal = document.getElementById('report-detail');
    if (e.target === reportModal) {
        reportModal.style.display = 'none';
    }
});

// --- LOGIC XUẤT DỮ LIỆU (History Table) ---

window.fetchAllHistoryData = async function () {
    const tbody = document.getElementById('table-body');
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center">Đang tải dữ liệu từ Firebase...</td></tr>';

    try {
        // BƯỚC 1: Lấy danh sách thiết bị để biết ID nào tên là gì
        // (Vì trong history chỉ lưu ID chứ không lưu tên phòng)
        const devicesSnap = await get(ref(db, 'devices'));
        const devicesMap = {}; // Tạo từ điển: ID -> Tên Phòng

        if (devicesSnap.exists()) {
            const devices = devicesSnap.val();
            Object.keys(devices).forEach(key => {
                devicesMap[key] = devices[key].name;
            });
        }

        // BƯỚC 2: Lấy dữ liệu lịch sử
        // Lưu ý: Lấy toàn bộ history có thể rất nặng.
        // Ở đây tôi ví dụ lấy 50 dòng cuối của MỖI thiết bị để demo cho nhanh.

        let allRows = []; // Mảng chứa tất cả dòng dữ liệu

        // Duyệt qua từng ID thiết bị để lấy lịch sử
        const deviceIds = Object.keys(devicesMap);

        for (const devId of deviceIds) {
            const devName = devicesMap[devId];

            // Query lấy 50 dòng cuối cùng của thiết bị này
            const historyQuery = query(ref(db, `history/${devId}`), limitToLast(50));
            const historySnap = await get(historyQuery);

            if (historySnap.exists()) {
                historySnap.forEach(child => {
                    const val = child.val();
                    // Đẩy vào mảng chung
                    allRows.push({
                        room: devName,
                        time: val.last_update, // Giả sử bạn lưu time dạng timestamp hoặc ISO string
                        temp: val.temp,
                        humid: val.humid,
                        light: val.lux
                    });
                });
            }
        }

        // BƯỚC 3: Sắp xếp lại theo thời gian (Mới nhất lên đầu)
        allRows.sort((a, b) => new Date(b.time) - new Date(a.time));

        // BƯỚC 4: Vẽ lên bảng
        tbody.innerHTML = '';
        if (allRows.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center">Không tìm thấy dữ liệu lịch sử.</td></tr>';
            return;
        }

        allRows.forEach((row, index) => {
            // Format lại thời gian cho đẹp
            const dateObj = new Date(row.time);
            const timeStr = dateObj.toLocaleString('vi-VN');

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${index + 1}</td>
                <td style="font-weight: 500; color: var(--primary-color)">${row.room}</td>
                <td>${timeStr}</td>
                <td>${row.temp} °C</td>
                <td>${row.humid} %</td>
                <td>${row.light} Lux</td>
            `;
            tbody.appendChild(tr);
        });

    } catch (error) {
        console.error("Lỗi lấy dữ liệu:", error);
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:red">Lỗi: ${error.message}</td></tr>`;
    }
};

// Hàm phụ: Xuất ra Excel (Đơn giản)
window.exportTableToExcel = function () {
    const table = document.querySelector(".data-table");
    let html = table.outerHTML;

    // Tạo link tải về
    const url = 'data:application/vnd.ms-excel,' + escape(html); // Tạo Blob Excel
    const link = document.createElement("a");
    link.href = url;
    link.download = "Du_Lieu_IoT_" + new Date().toISOString().slice(0, 10) + ".xls";
    link.click();
}

// --- LOGIC CÀI ĐẶT MQTT ---

// 1. Hàm lưu cấu hình MQTT khi bấm nút Save
window.saveMQTTSettings = function (event) {
    event.preventDefault();

    const config = {
        host: document.getElementById('cfg-mqtt-host').value.trim(),
        port: parseInt(document.getElementById('cfg-mqtt-port').value.trim()),
        path: document.getElementById('cfg-mqtt-path').value.trim(),
        useSSL: document.getElementById('cfg-mqtt-ssl').value === 'true',
        username: document.getElementById('cfg-mqtt-username').value.trim(),
        password: document.getElementById('cfg-mqtt-password').value.trim(),
        keepalive: parseInt(document.getElementById('cfg-mqtt-keepalive').value.trim()) || 60,
        reconnect: document.getElementById('cfg-mqtt-reconnect').value === 'true'
    };

    // Validate
    if (!config.host) {
        alert("Vui lòng nhập MQTT Broker Host!");
        return;
    }
    if (!config.port || config.port < 1 || config.port > 65535) {
        alert("Port không hợp lệ! (1-65535)");
        return;
    }

    // Lưu vào localStorage
    localStorage.setItem('mqtt_config', JSON.stringify(config));

    alert("Đã lưu cấu hình MQTT! Trang web sẽ tải lại để áp dụng.");
    location.reload();
};

// 2. Hàm điền dữ liệu MQTT cũ vào form khi mở tab
function loadSettingsToForm() {
    const savedString = localStorage.getItem('mqtt_config');
    if (savedString) {
        try {
            const config = JSON.parse(savedString);
            document.getElementById('cfg-mqtt-host').value = config.host || 'broker.emqx.io';
            document.getElementById('cfg-mqtt-port').value = config.port || 8083;
            document.getElementById('cfg-mqtt-path').value = config.path || '/mqtt';
            document.getElementById('cfg-mqtt-ssl').value = config.useSSL ? 'true' : 'false';
            document.getElementById('cfg-mqtt-username').value = config.username || '';
            document.getElementById('cfg-mqtt-password').value = config.password || '';
            document.getElementById('cfg-mqtt-keepalive').value = config.keepalive || 60;
            document.getElementById('cfg-mqtt-reconnect').value = config.reconnect !== false ? 'true' : 'false';
        } catch (e) {
            console.error("Lỗi load cấu hình MQTT:", e);
        }
    } else {
        // Load giá trị mặc định
        document.getElementById('cfg-mqtt-host').value = 'broker.emqx.io';
        document.getElementById('cfg-mqtt-port').value = 8083;
        document.getElementById('cfg-mqtt-path').value = '/mqtt';
        document.getElementById('cfg-mqtt-ssl').value = 'false';
        document.getElementById('cfg-mqtt-keepalive').value = 60;
        document.getElementById('cfg-mqtt-reconnect').value = 'true';
    }
}

// 3. Hàm xóa cấu hình MQTT (Reset)
window.clearMQTTSettings = function () {
    if (confirm("Bạn có chắc muốn xóa cấu hình MQTT và dùng lại mặc định?")) {
        localStorage.removeItem('mqtt_config');
        alert("Đã xóa cấu hình. Trang sẽ tải lại.");
        location.reload();
    }
};

// 4. Hàm test kết nối MQTT
window.testMQTTConnection = function () {
    const host = document.getElementById('cfg-mqtt-host').value.trim();
    const port = document.getElementById('cfg-mqtt-port').value.trim();
    const path = document.getElementById('cfg-mqtt-path').value.trim();
    const useSSL = document.getElementById('cfg-mqtt-ssl').value === 'true';
    const username = document.getElementById('cfg-mqtt-username').value.trim();
    const password = document.getElementById('cfg-mqtt-password').value.trim();

    if (!host || !port) {
        alert("Vui lòng nhập đầy đủ Host và Port!");
        return;
    }

    alert("Đang test kết nối MQTT...\n\nBroker: " + host + ":" + port + "\nPath: " + path + "\nSSL: " + (useSSL ? "Có" : "Không"));

    try {
        const testClientId = "TestClient_" + Math.random().toString(16).substr(2, 8);
        const testClient = new Paho.MQTT.Client(host, parseInt(port), path, testClientId);

        testClient.onConnectionLost = (obj) => {
            alert("❌ Test thất bại: Mất kết nối\n" + obj.errorMessage);
        };

        const connectOptions = {
            onSuccess: () => {
                alert("✅ Kết nối MQTT thành công!\n\nBroker: " + host + ":" + port + "\n\nBạn có thể lưu cấu hình này.");
                testClient.disconnect();
            },
            onFailure: (e) => {
                alert("❌ Kết nối MQTT thất bại!\n\nLỗi: " + e.errorMessage + "\n\nVui lòng kiểm tra lại thông tin broker.");
            },
            useSSL: useSSL,
            timeout: 10
        };

        if (username) {
            connectOptions.userName = username;
            connectOptions.password = password;
        }

        testClient.connect(connectOptions);
    } catch (e) {
        alert("❌ Lỗi khởi tạo test MQTT:\n" + e.message);
    }
};

// ============================================================
// WIFI SETUP GUIDE - Hiển thị hướng dẫn kết nối WiFi cho ESP32
// ============================================================
window.showWiFiSetupGuide = async function() {
    const instructionsDiv = document.getElementById('wifi-setup-instructions');
    
    if (!instructionsDiv) {
        console.error('wifi-setup-instructions div not found');
        return;
    }

    // Hiển thị loading
    instructionsDiv.innerHTML = `
        <div style="text-align: center; padding: 20px;">
            <i class="fa-solid fa-spinner fa-spin" style="font-size: 24px; color: #f59e0b;"></i>
            <p style="margin-top: 10px; color: #78350f;">Đang tải thông tin thiết bị...</p>
        </div>
    `;
    instructionsDiv.style.display = 'block';

    try {
        // Lấy danh sách devices từ Firebase
        const devicesRef = ref(db, 'devices');
        const snapshot = await get(devicesRef);
        
        if (!snapshot.exists()) {
            instructionsDiv.innerHTML = `
                <p style="color: #dc2626; margin: 0;">
                    <i class="fa-solid fa-circle-exclamation"></i> 
                    Không tìm thấy thiết bị nào. Vui lòng thêm thiết bị trước.
                </p>
            `;
            return;
        }
        
        const devices = snapshot.val();
        let setupDevices = [];
        
        // Tìm devices đang ở Setup Mode
        for (const [id, data] of Object.entries(devices)) {
            if (data.setup_mode === true) {
                setupDevices.push({
                    id: id,
                    name: data.name || id,
                    ap_ssid: data.ap_ssid || `ESP32-Setup-${id}`,
                    ap_ip: data.ap_ip || '192.168.4.1'
                });
            }
        }
        
        if (setupDevices.length === 0) {
            instructionsDiv.innerHTML = `
                <div style="padding: 10px;">
                    <p style="color: #059669; margin: 0 0 10px 0;">
                        <i class="fa-solid fa-circle-check"></i> 
                        <strong>Tất cả thiết bị đã kết nối WiFi.</strong>
                    </p>
                    <p style="color: #666; font-size: 0.85rem; margin: 0;">
                        Nếu bạn muốn đổi WiFi, vui lòng reset ESP32 hoặc xóa WiFi đã lưu trong code.
                    </p>
                </div>
            `;
        } else {
            // Hiển thị hướng dẫn cho từng thiết bị
            let html = '<h5 style="margin: 0 0 15px 0; color: #92400e;"><i class="fa-solid fa-mobile-screen"></i> Thiết bị cần cấu hình WiFi:</h5>';
            
            setupDevices.forEach((dev, index) => {
                html += `
                    <div style="margin: 15px 0; padding: 15px; background: #fffbeb; border-radius: 6px; border: 1px solid #fbbf24;">
                        <h6 style="margin: 0 0 10px 0; color: #92400e; font-weight: 600;">
                            ${index + 1}. ${dev.name} <span style="color: #999; font-weight: normal; font-size: 0.85em;">(${dev.id})</span>
                        </h6>
                        <ol style="margin: 5px 0; padding-left: 20px; color: #78350f; font-size: 0.85rem; line-height: 1.8;">
                            <li>Bật <strong>điện thoại</strong> hoặc <strong>laptop</strong>, vào <strong>Cài đặt WiFi</strong></li>
                            <li>Tìm và kết nối vào WiFi: 
                                <br><span style="display: inline-block; margin: 5px 0; padding: 5px 10px; background: #f59e0b; color: white; border-radius: 4px; font-weight: 600;">
                                    <i class="fa-solid fa-wifi"></i> ${dev.ap_ssid}
                                </span>
                                <br><small style="color: #999;">(Không cần mật khẩu)</small>
                            </li>
                            <li>Trình duyệt sẽ <strong>tự động mở</strong> trang cấu hình
                                <br><small style="color: #666;">Nếu không tự mở, hãy truy cập: 
                                    <code style="background: white; padding: 2px 6px; border-radius: 3px; color: #f59e0b; font-weight: 600;">${dev.ap_ip}</code>
                                </small>
                            </li>
                            <li>Chọn <strong>WiFi gia đình</strong> của bạn trong danh sách hiển thị</li>
                            <li>Nhập <strong>mật khẩu WiFi</strong> và nhấn nút <strong>"Save"</strong></li>
                            <li>ESP32 sẽ tự động kết nối và xuất hiện trên Dashboard trong <strong>vài giây</strong> ✅</li>
                        </ol>
                    </div>
                `;
            });
            
            html += `
                <div style="margin-top: 15px; padding: 10px; background: #f0f9ff; border-radius: 6px; border-left: 3px solid #3b82f6;">
                    <p style="margin: 0; color: #1e40af; font-size: 0.85rem;">
                        <i class="fa-solid fa-circle-info"></i> 
                        <strong>Mẹo:</strong> Sau khi cấu hình xong, trang này sẽ tự động cập nhật khi ESP32 kết nối thành công.
                    </p>
                </div>
            `;
            
            instructionsDiv.innerHTML = html;
        }
        
    } catch (error) {
        console.error('Error loading WiFi setup guide:', error);
        instructionsDiv.innerHTML = `
            <p style="color: #dc2626; margin: 0;">
                <i class="fa-solid fa-triangle-exclamation"></i> 
                Lỗi khi tải thông tin: ${error.message}
            </p>
        `;
    }
};

