// Global state
let map = null;
let gpxData = {
  points: [],      // Array of {lat, lon, ele, time, dist}
  totalDistance: 0, // in meters
  totalAscent: 0   // cumulative elevation gain in meters
};
let isPlaying = false;
let isRecording = false;
let animationFrameId = null;
let currentProgress = 0; // 0 to 1
let activeColor = '#00f3ff';
let lastBearing = null; // Used for smoothing camera rotation

// DOM Elements
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const browseBtn = document.getElementById('browse-btn');
const fileInfo = document.getElementById('file-info');
const infoFilename = document.getElementById('info-filename');
const infoDetails = document.getElementById('info-details');
const removeFileBtn = document.getElementById('remove-file-btn');

const settingsSection = document.getElementById('settings-section');
const actionSection = document.getElementById('action-section');

const durationInput = document.getElementById('duration-input');
const durationValue = document.getElementById('duration-value');
const resolutionSelect = document.getElementById('resolution-select');
const lineWidthSelect = document.getElementById('line-width-select');
const mapStyleSelect = document.getElementById('map-style-select');
const colorDots = document.querySelectorAll('.color-dot');

const previewBtn = document.getElementById('preview-btn');
const recordBtn = document.getElementById('record-btn');

const renderingOverlay = document.getElementById('rendering-overlay');
const progressBarFill = document.getElementById('progress-bar-fill');
const progressText = document.getElementById('progress-text');
const cancelRecordBtn = document.getElementById('cancel-record-btn');
const mapViewport = document.getElementById('map-viewport');

// Elevation Panel DOMs
const elevationPanel = document.getElementById('elevation-panel');
const maxEleSpan = document.getElementById('max-ele');
const minEleSpan = document.getElementById('min-ele');
const currentEleSpan = document.getElementById('current-ele');
const totalAscentSpan = document.getElementById('total-ascent');
const currentDistSpan = document.getElementById('current-dist');
const totalDistSpan = document.getElementById('total-dist');
const elevationChart = document.getElementById('elevation-chart');

// Map Styles mapping
const MAP_STYLES = {
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  voyager: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json'
};

// Initialize Map
function initMap() {
  map = new maplibregl.Map({
    container: 'map',
    style: MAP_STYLES.dark,
    center: [127.0, 37.5], // Default center (Seoul)
    zoom: 11,
    pitch: 0,
    bearing: 0,
    preserveDrawingBuffer: true // Crucial for Canvas recording!
  });

  map.on('load', () => {
    setupMapLayers();
  });
}

// Setup GPX GeoJSON Source and Layers
function setupMapLayers() {
  // 이미 레이어가 추가되어 있으면 중복 추가 방지
  if (map.getSource('route-full')) return;

  // Add source for the full path (background)
  map.addSource('route-full', {
    type: 'geojson',
    data: {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: []
      }
    }
  });

  // Add layer for the full path (drawn FIRST = bottom)
  map.addLayer({
    id: 'route-full-layer',
    type: 'line',
    source: 'route-full',
    layout: {
      'line-join': 'round',
      'line-cap': 'round'
    },
    paint: {
      'line-color': activeColor,
      'line-width': Math.max(2, parseInt(lineWidthSelect.value, 10) - 2),
      'line-opacity': 0.25
    }
  });

  // Add source for the completed path (foreground)
  map.addSource('route-completed', {
    type: 'geojson',
    data: {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: []
      }
    }
  });

  // Add layer for the completed path (drawn SECOND = on top of full path)
  map.addLayer({
    id: 'route-completed-layer',
    type: 'line',
    source: 'route-completed',
    layout: {
      'line-join': 'round',
      'line-cap': 'round'
    },
    paint: {
      'line-color': activeColor,
      'line-width': parseInt(lineWidthSelect.value, 10),
      'line-opacity': 0.95
    }
  });

  // Add marker source
  map.addSource('marker-source', {
    type: 'geojson',
    data: {
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [0, 0]
      }
    }
  });

  // Add glowing marker layer (drawn LAST = topmost)
  map.addLayer({
    id: 'marker-glow-layer',
    type: 'circle',
    source: 'marker-source',
    paint: {
      'circle-radius': parseInt(lineWidthSelect.value, 10) * 2,
      'circle-color': activeColor,
      'circle-opacity': 0.4,
      'circle-stroke-width': 1,
      'circle-stroke-color': '#ffffff'
    }
  });

  map.addLayer({
    id: 'marker-core-layer',
    type: 'circle',
    source: 'marker-source',
    paint: {
      'circle-radius': Math.max(4, parseInt(lineWidthSelect.value, 10) * 0.8),
      'circle-color': '#ffffff',
      'circle-opacity': 1
    }
  });
}

// Update layers styling when settings change
function updateLayersStyle() {
  if (!map || !map.getLayer('route-completed-layer')) return;

  const width = parseInt(lineWidthSelect.value, 10);
  
  map.setPaintProperty('route-completed-layer', 'line-color', activeColor);
  map.setPaintProperty('route-completed-layer', 'line-width', width);

  map.setPaintProperty('route-full-layer', 'line-color', activeColor);
  map.setPaintProperty('route-full-layer', 'line-width', Math.max(2, width - 2));

  map.setPaintProperty('marker-glow-layer', 'circle-color', activeColor);
  map.setPaintProperty('marker-glow-layer', 'circle-radius', width * 2);
  map.setPaintProperty('marker-core-layer', 'circle-radius', Math.max(4, width * 0.8));

  // Redraw elevation chart to match selected color
  if (gpxData.points.length > 0) {
    drawElevationChart(currentProgress);
  }
}

// Setup Event Listeners
function setupEvents() {
  // Drag & Drop
  ['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    }, false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
    }, false);
  });

  dropZone.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    const files = dt.files;
    if (files.length > 0) {
      handleGPXFile(files[0]);
    }
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleGPXFile(e.target.files[0]);
    }
  });

  browseBtn.addEventListener('click', () => {
    fileInput.click();
  });

  removeFileBtn.addEventListener('click', () => {
    resetGPXData();
  });

  // Settings
  durationInput.addEventListener('input', (e) => {
    durationValue.textContent = `${e.target.value}초`;
  });

  lineWidthSelect.addEventListener('change', updateLayersStyle);

  colorDots.forEach(dot => {
    dot.addEventListener('click', (e) => {
      colorDots.forEach(d => d.classList.remove('active'));
      e.target.classList.add('active');
      activeColor = e.target.getAttribute('data-color');
      updateLayersStyle();
    });
  });

  mapStyleSelect.addEventListener('change', (e) => {
    const styleKey = e.target.value;
    map.setStyle(MAP_STYLES[styleKey]);
    map.once('idle', () => {
      setupMapLayers();
      if (gpxData.points.length > 0) {
        // 전체 경로 복원
        drawFullPath();
        // 현재 진행된 경로 및 마커 위치 복원
        if (currentProgress > 0) {
          const cameraMode = document.querySelector('input[name="camera-mode"]:checked').value;
          updateSimulationFrame(currentProgress, cameraMode);
        }
      }
    });
  });

  // Window resize triggers elevation chart redraw
  window.addEventListener('resize', () => {
    if (gpxData.points.length > 0) {
      drawElevationChart(currentProgress);
    }
  });

  // Action Buttons
  previewBtn.addEventListener('click', togglePreview);
  recordBtn.addEventListener('click', startRecordingFlow);

  // Demo Button
  const loadDemoBtn = document.getElementById('load-demo-btn');
  if (loadDemoBtn) {
    loadDemoBtn.addEventListener('click', () => {
      fetch('sample.gpx')
        .then(response => {
          if (!response.ok) throw new Error('샘플 GPX 파일을 가져오지 못했습니다.');
          return response.text();
        })
        .then(text => {
          parseGPX(text, 'Namsan_Sample_Route.gpx');
        })
        .catch(err => {
          console.error(err);
          alert('데모 GPX 로드 실패: ' + err.message);
        });
    });
  }
}

// Handle GPX File Input
function handleGPXFile(file) {
  if (!file.name.endsWith('.gpx')) {
    alert('올바른 .gpx 파일을 업로드해 주세요.');
    return;
  }

  const reader = new FileReader();
  reader.onload = function(e) {
    const gpxText = e.target.result;
    parseGPX(gpxText, file.name);
  };
  reader.readAsText(file);
}

// Parse GPX text using DOMParser
function parseGPX(gpxText, filename) {
  try {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(gpxText, 'text/xml');
    
    const parserError = xmlDoc.getElementsByTagName('parsererror');
    if (parserError.length > 0) {
      throw new Error('XML 파싱 오류');
    }

    const trackPoints = xmlDoc.getElementsByTagName('trkpt');
    if (trackPoints.length === 0) {
      alert('GPX 파일에서 유효한 경로 포인트를 찾을 수 없습니다.');
      return;
    }

    const points = [];
    let accumulatedDist = 0;
    let totalAscent = 0;
    let minEle = Infinity;
    let maxEle = -Infinity;

    for (let i = 0; i < trackPoints.length; i++) {
      const pt = trackPoints[i];
      const lat = parseFloat(pt.getAttribute('lat'));
      const lon = parseFloat(pt.getAttribute('lon'));
      
      const eleEl = pt.getElementsByTagName('ele')[0];
      const ele = eleEl ? parseFloat(eleEl.textContent) : 0;
      
      const timeEl = pt.getElementsByTagName('time')[0];
      const time = timeEl ? new Date(timeEl.textContent) : null;

      if (isNaN(lat) || isNaN(lon)) continue;

      if (ele < minEle) minEle = ele;
      if (ele > maxEle) maxEle = ele;

      if (i > 0) {
        const prevPt = points[points.length - 1];
        accumulatedDist += haversineDistance(prevPt.lat, prevPt.lon, lat, lon);
        // 누적 상승 계산 (이전 포인트보다 고도가 높아진 경우만)
        const eleGain = ele - prevPt.ele;
        if (eleGain > 0) totalAscent += eleGain;
      }

      points.push({ lat, lon, ele, time, dist: accumulatedDist });
    }

    if (points.length < 2) {
      alert('비행 애니메이션을 위해서는 최소 2개 이상의 유효한 트랙 포인트가 필요합니다.');
      return;
    }

    gpxData.points = points;
    gpxData.totalDistance = accumulatedDist;
    gpxData.totalAscent = totalAscent;

    // Show File Meta Info
    infoFilename.textContent = filename;
    const distanceKm = (accumulatedDist / 1000).toFixed(2);
    infoDetails.textContent = `거리: ${distanceKm} km | 포인트: ${points.length}개`;

    // Fill elevation stats
    maxEleSpan.textContent = Math.round(maxEle);
    minEleSpan.textContent = Math.round(minEle);
    currentEleSpan.textContent = Math.round(points[0].ele);
    totalAscentSpan.textContent = Math.round(totalAscent);
    totalDistSpan.textContent = (accumulatedDist / 1000).toFixed(2);
    currentDistSpan.textContent = '0.00';
    
    // Toggle UI State
    dropZone.classList.add('hidden');
    fileInfo.classList.remove('hidden');
    settingsSection.classList.remove('disabled');
    actionSection.classList.remove('disabled');
    elevationPanel.classList.remove('hidden');

    // Zoom Map to GPX bounds
    zoomToFitRoute();
    drawFullPath();
    
    // Draw initial elevation chart
    currentProgress = 0;
    setTimeout(() => {
      drawElevationChart(0);
    }, 200);

  } catch (err) {
    console.error(err);
    alert('GPX 파일을 파싱하는 과정에서 에러가 발생했습니다. 파일 형식을 확인하세요.');
  }
}

// Reset GPX Data state
function resetGPXData() {
  stopAnimation();
  gpxData = { points: [], totalDistance: 0 };
  lastBearing = null;
  
  dropZone.classList.remove('hidden');
  fileInfo.classList.add('hidden');
  settingsSection.classList.add('disabled');
  actionSection.classList.add('disabled');
  elevationPanel.classList.add('hidden');
  
  if (map) {
    if (map.getSource('route-completed')) {
      map.getSource('route-completed').setData({
        type: 'Feature', geometry: { type: 'LineString', coordinates: [] }
      });
    }
    if (map.getSource('route-full')) {
      map.getSource('route-full').setData({
        type: 'Feature', geometry: { type: 'LineString', coordinates: [] }
      });
    }
    if (map.getSource('marker-source')) {
      map.getSource('marker-source').setData({
        type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }
      });
    }
    map.easeTo({ pitch: 0, bearing: 0, zoom: 11, center: [127.0, 37.5] });
  }
}

// Zoom map to fit GPX LineString
function zoomToFitRoute() {
  if (gpxData.points.length === 0) return;
  
  const bounds = new maplibregl.LngLatBounds();
  gpxData.points.forEach(pt => bounds.extend([pt.lon, pt.lat]));
  
  map.fitBounds(bounds, {
    padding: { top: 60, bottom: 120, left: 60, right: 60 }, // Bottom padding for elevation profile
    duration: 1000
  });
}

// Render background full route path
function drawFullPath() {
  if (!map || !map.getSource('route-full')) return;
  
  const coordinates = gpxData.points.map(pt => [pt.lon, pt.lat]);
  map.getSource('route-full').setData({
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'LineString',
      coordinates: coordinates
    }
  });
}

// Interpolate position/elevation/time based on progress (0 to 1)
function getInterpolatedPoint(progress) {
  const points = gpxData.points;
  const targetDist = progress * gpxData.totalDistance;

  // Binary search for segment
  let low = 0;
  let high = points.length - 1;
  let idx = 0;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (points[mid].dist <= targetDist) {
      idx = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (idx >= points.length - 1) {
    return { ...points[points.length - 1], nextIndex: points.length - 1 };
  }

  const p1 = points[idx];
  const p2 = points[idx + 1];
  const segmentDist = p2.dist - p1.dist;
  
  let factor = 0;
  if (segmentDist > 0) {
    factor = (targetDist - p1.dist) / segmentDist;
  }

  const lon = p1.lon + (p2.lon - p1.lon) * factor;
  const lat = p1.lat + (p2.lat - p1.lat) * factor;
  const ele = p1.ele + (p2.ele - p1.ele) * factor;
  
  return { lat, lon, ele, nextIndex: idx + 1 };
}

// Shortest angle difference interpolation (prevents camera spinning 360)
function interpolateBearing(current, target, factor) {
  if (current === null) return target;
  let diff = target - current;
  while (diff < -180) diff += 360;
  while (diff > 180) diff -= 360;
  return (current + diff * factor + 360) % 360;
}

// Calculate Heading (Bearing) between two points in degrees
function calculateBearing(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const toDeg = 180 / Math.PI;

  const φ1 = lat1 * toRad;
  const φ2 = lat2 * toRad;
  const Δλ = (lon2 - lon1) * toRad;

  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  
  let brng = Math.atan2(y, x) * toDeg;
  return (brng + 360) % 360;
}

// Haversine formula to compute distance in meters between two lat/lon points
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Earth radius in meters
  const toRad = Math.PI / 180;
  
  const φ1 = lat1 * toRad;
  const φ2 = lat2 * toRad;
  const Δφ = (lat2 - lat1) * toRad;
  const Δλ = (lon2 - lon1) * toRad;

  const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ/2) * Math.sin(Δλ/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

  return R * c;
}

// Utility: convert HEX to RGBA color string
function hexToRgbA(hex, alpha) {
  let c;
  if (/^#([A-Fa-f0-9]{3}){1,2}$/.test(hex)) {
    c = hex.substring(1).split('');
    if (c.length == 3) {
      c = [c[0], c[0], c[1], c[1], c[2], c[2]];
    }
    c = '0x' + c.join('');
    return 'rgba(' + [(c >> 16) & 255, (c >> 8) & 255, c & 255].join(',') + ',' + alpha + ')';
  }
  return hex;
}

// ---------------- ELEVATION CHART DRAWER ----------------

function drawElevationChart(progress) {
  if (!elevationChart || gpxData.points.length === 0) return;
  
  const ctx = elevationChart.getContext('2d');
  const rect = elevationChart.parentNode.getBoundingClientRect();
  
  // Set resolution based on device pixel ratio
  elevationChart.width = rect.width * window.devicePixelRatio;
  elevationChart.height = rect.height * window.devicePixelRatio;
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
  
  const w = rect.width;
  const h = rect.height;
  ctx.clearRect(0, 0, w, h);
  
  const points = gpxData.points;
  
  // Find min/max elevation
  let minEle = Infinity;
  let maxEle = -Infinity;
  points.forEach(pt => {
    if (pt.ele < minEle) minEle = pt.ele;
    if (pt.ele > maxEle) maxEle = pt.ele;
  });
  
  const eleDiff = maxEle - minEle;
  const padding = eleDiff > 0 ? eleDiff * 0.15 : 10;
  const minLimit = minEle - padding;
  const maxLimit = maxEle + padding;
  const limitRange = maxLimit - minLimit;
  
  // Create chart path helper
  function getXY(index) {
    const pt = points[index];
    const x = (pt.dist / gpxData.totalDistance) * w;
    const y = h - ((pt.ele - minLimit) / (limitRange || 1)) * h;
    return { x, y };
  }
  
  // Draw fill gradient
  ctx.beginPath();
  const start = getXY(0);
  ctx.moveTo(start.x, start.y);
  for (let i = 1; i < points.length; i++) {
    const pos = getXY(i);
    ctx.lineTo(pos.x, pos.y);
  }
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  
  const fillGradient = ctx.createLinearGradient(0, 0, 0, h);
  fillGradient.addColorStop(0, hexToRgbA(activeColor, 0.25));
  fillGradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = fillGradient;
  ctx.fill();
  
  // Draw stroke line
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  for (let i = 1; i < points.length; i++) {
    const pos = getXY(i);
    ctx.lineTo(pos.x, pos.y);
  }
  ctx.strokeStyle = activeColor;
  ctx.lineWidth = 2.5;
  ctx.stroke();
  
  // Draw timeline progress indicator (Vertical line & dot)
  const curX = progress * w;
  
  ctx.beginPath();
  ctx.moveTo(curX, 0);
  ctx.lineTo(curX, h);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.stroke();
  ctx.setLineDash([]); // Reset dashed state
  
  const curPt = getInterpolatedPoint(progress);
  const curY = h - ((curPt.ele - minLimit) / (limitRange || 1)) * h;
  
  // Glow Dot
  ctx.beginPath();
  ctx.arc(curX, curY, 6, 0, Math.PI * 2);
  ctx.fillStyle = hexToRgbA(activeColor, 0.4);
  ctx.fill();
  
  // Core Dot
  ctx.beginPath();
  ctx.arc(curX, curY, 3, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  
  // Update stats UI: 현재 고도, 현재 누적상승, 현재 거리
  currentEleSpan.textContent = Math.round(curPt.ele);

  // 현재 진행 거리 기준 누적상승 계산 (progress 기반 정확한 계산)
  // points는 함수 상단의 const points = gpxData.points 재사용
  const targetDist = progress * gpxData.totalDistance;
  let ascent = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].dist > targetDist) {
      // 마지막 구간 일부 반영 (비례 보간)
      const segGain = points[i].ele - points[i - 1].ele;
      if (segGain > 0) {
        const ratio = (targetDist - points[i - 1].dist) / (points[i].dist - points[i - 1].dist);
        ascent += segGain * ratio;
      }
      break;
    }
    const gain = points[i].ele - points[i - 1].ele;
    if (gain > 0) ascent += gain;
  }
  totalAscentSpan.textContent = Math.round(ascent);
  currentDistSpan.textContent = (targetDist / 1000).toFixed(2);
}

// ---------------- ANIMATION & PREVIEW LOGIC ----------------

// Toggle Preview (Real-time playback)
function togglePreview() {
  if (isRecording) return;

  if (isPlaying) {
    stopAnimation();
    previewBtn.innerHTML = `
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="5 3 19 12 5 21 5 3"></polygon>
      </svg>
      <span>경로 미리보기</span>
    `;
  } else {
    isPlaying = true;
    previewBtn.innerHTML = `
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <rect x="6" y="4" width="4" height="16"></rect>
        <rect x="14" y="4" width="4" height="16"></rect>
      </svg>
      <span>재생 일시정지</span>
    `;
    
    recordBtn.disabled = true;
    
    currentProgress = 0;
    lastBearing = null; // Reset bearing smoothing
    const durationMs = parseInt(durationInput.value, 10) * 1000;
    let startTime = null;

    const cameraMode = document.querySelector('input[name="camera-mode"]:checked').value;
    
    // Setup initial zoom and view angle
    const startPt = gpxData.points[0];
    const initialBearing = calculateBearing(startPt.lat, startPt.lon, gpxData.points[1].lat, gpxData.points[1].lon);
    
    const targetPitch = (cameraMode === 'chase-rot' || cameraMode === 'chase-fixed') ? 55 : 0;
    const targetBearing = cameraMode === 'chase-rot' ? initialBearing : 0;
    
    const canvas = map.getCanvas();
    const isVertical = canvas.height > canvas.width;
    const targetZoom = (cameraMode === 'chase-rot' || cameraMode === 'chase-fixed') 
      ? (isVertical ? 13.5 : 14.5) 
      : (isVertical ? 11.5 : 13);
    
    map.jumpTo({
      center: [startPt.lon, startPt.lat],
      zoom: targetZoom,
      pitch: targetPitch,
      bearing: targetBearing
    });

    function animate(timestamp) {
      if (!startTime) startTime = timestamp;
      const elapsed = timestamp - startTime;
      currentProgress = Math.min(1, elapsed / durationMs);

      updateSimulationFrame(currentProgress, cameraMode);

      if (currentProgress < 1 && isPlaying) {
        animationFrameId = requestAnimationFrame(animate);
      } else {
        stopAnimation();
        previewBtn.innerHTML = `
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="5 3 19 12 5 21 5 3"></polygon>
          </svg>
          <span>경로 미리보기</span>
        `;
      }
    }

    animationFrameId = requestAnimationFrame(animate);
  }
}

// Stop any running animations
function stopAnimation() {
  isPlaying = false;
  recordBtn.disabled = false;
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
}

// Update single frame of simulation given progress (0 to 1)
function updateSimulationFrame(progress, cameraMode) {
  const currentPt = getInterpolatedPoint(progress);
  const points = gpxData.points;
  const completedCoords = [];
  const totalPointsCount = points.length;
  
  // Collect all raw points passed so far
  const passedIndex = Math.max(0, currentPt.nextIndex - 1);
  for (let i = 0; i <= passedIndex; i++) {
    completedCoords.push([points[i].lon, points[i].lat]);
  }
  // Always add the current interpolated position as the last coord
  completedCoords.push([currentPt.lon, currentPt.lat]);

  // Update completed route line (need at least 2 coords for a line)
  if (map.getSource('route-completed') && completedCoords.length >= 2) {
    map.getSource('route-completed').setData({
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: completedCoords
      }
    });
  }

  // Update marker position
  if (map.getSource('marker-source')) {
    map.getSource('marker-source').setData({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [currentPt.lon, currentPt.lat]
      }
    });
  }

  // Draw local UI elevation chart
  drawElevationChart(progress);

  const canvas = map.getCanvas();
  const isVertical = canvas.height > canvas.width;

  // Map camera dynamics
  if (cameraMode === 'chase-rot') {
    // 3D Chase mode WITH ROTATION DAMPING (anti-shake)
    let heading = 0;
    if (passedIndex < totalPointsCount - 1) {
      const currentPoint = points[passedIndex];
      const nextPoint = points[passedIndex + 1];
      heading = calculateBearing(currentPoint.lat, currentPoint.lon, nextPoint.lat, nextPoint.lon);
    }
    
    // Smooth bearing using EMA (0.06 damping factor)
    lastBearing = interpolateBearing(lastBearing, heading, 0.06);

    map.jumpTo({
      center: [currentPt.lon, currentPt.lat],
      bearing: lastBearing,
      pitch: 55,
      zoom: isVertical ? 13.5 : 14.5
    });
  } else if (cameraMode === 'chase-fixed') {
    // 3D Chase mode WITH NO CAMERA ROTATION (North fixed, 3D tilt)
    map.jumpTo({
      center: [currentPt.lon, currentPt.lat],
      bearing: 0,
      pitch: 55,
      zoom: isVertical ? 13.5 : 14.5
    });
  } else {
    // 2D Overview mode
    map.jumpTo({
      center: [currentPt.lon, currentPt.lat],
      bearing: 0,
      pitch: 0,
      zoom: isVertical ? 11.5 : 13
    });
  }
}

// ---------------- VIDEO RECORDING ENGINE (WITH GRAPH COMPOSITING) ----------------

let mediaRecorder = null;
let videoEncoder = null;
let mp4Muxer = null;
let recordedChunks = [];
let abortRecording = false;

// We will use an offscreen Canvas to draw the map + overlay elevation chart
let compositeCanvas = null;
let compositeCtx = null;

// Scale and render elevation chart directly into composite canvas context
function drawElevationChartOnComposite(ctx, mapW, mapH, progress) {
  const points = gpxData.points;
  if (points.length < 2) return;

  const isVertical = mapH > mapW;

  // Chart size and coordinates on the output video
  // Responsive based on video height/width
  const chartW = isVertical ? mapW * 0.88 : mapW * 0.9;
  const chartH = isVertical ? Math.min(120, mapH * 0.1) : Math.min(120, mapH * 0.12);
  const chartX = (mapW - chartW) / 2;
  const bottomOffset = isVertical ? Math.max(160, mapH * 0.15) : 30;
  const chartY = mapH - chartH - bottomOffset;

  // 1. Draw Glassmorphism Container Background
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
  ctx.shadowBlur = 20;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 4;

  ctx.fillStyle = 'rgba(13, 16, 23, 0.75)'; // Glass dark panel
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.lineWidth = 1.5;
  
  // Round rect drawing helper
  const r = 12; // corner radius
  ctx.beginPath();
  ctx.moveTo(chartX + r, chartY);
  ctx.lineTo(chartX + chartW - r, chartY);
  ctx.quadraticCurveTo(chartX + chartW, chartY, chartX + chartW, chartY + r);
  ctx.lineTo(chartX + chartW, chartY + chartH - r);
  ctx.quadraticCurveTo(chartX + chartW, chartY + chartH, chartX + chartW - r, chartY + chartH);
  ctx.lineTo(chartX + r, chartY + chartH);
  ctx.quadraticCurveTo(chartX, chartY + chartH, chartX, chartY + chartH - r);
  ctx.lineTo(chartX, chartY + r);
  ctx.quadraticCurveTo(chartX, chartY, chartX + r, chartY);
  ctx.closePath();
  ctx.fill();
  ctx.shadowColor = 'transparent'; // Reset shadow
  ctx.stroke();

  // 2. Draw Stats header text
  let minEle = Infinity;
  let maxEle = -Infinity;
  points.forEach(pt => {
    if (pt.ele < minEle) minEle = pt.ele;
    if (pt.ele > maxEle) maxEle = pt.ele;
  });
  const curPt = getInterpolatedPoint(progress);

  // 현재 progress 기준 누적상승 계산
  const targetDist = progress * gpxData.totalDistance;
  let ascent = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].dist > targetDist) {
      const segGain = points[i].ele - points[i - 1].ele;
      if (segGain > 0) {
        const ratio = (targetDist - points[i - 1].dist) / (points[i].dist - points[i - 1].dist);
        ascent += segGain * ratio;
      }
      break;
    }
    const gain = points[i].ele - points[i - 1].ele;
    if (gain > 0) ascent += gain;
  }
  const currentDistKm = (targetDist / 1000).toFixed(2);
  const totalDistKm = (gpxData.totalDistance / 1000).toFixed(2);

  ctx.save();
  
  // Left side: Title and Min/Max elevation
  ctx.textAlign = 'left';
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 13px sans-serif';
  ctx.fillText('고도 프로필', chartX + 15, chartY + 22);

  ctx.fillStyle = '#9ca3af'; // secondary grey
  ctx.font = '11px sans-serif';
  ctx.fillText(`최저: ${Math.round(minEle)}m  |  최대: ${Math.round(maxEle)}m`, chartX + 105, chartY + 22);

  // Right side: Current status and Distance (drawn with right-alignment to prevent overlapping)
  ctx.textAlign = 'right';
  const distText = `거리: ${currentDistKm}/${totalDistKm}km`;
  const currentText = `현재: ${Math.round(curPt.ele)}m (↑${Math.round(ascent)}m)`;
  
  ctx.fillStyle = '#9ca3af';
  ctx.font = '11px sans-serif';
  ctx.fillText(distText, chartX + chartW - 15, chartY + 22);
  
  const distTextWidth = ctx.measureText(distText).width;
  
  ctx.fillStyle = activeColor;
  ctx.font = 'bold 12px sans-serif';
  ctx.fillText(currentText, chartX + chartW - 15 - distTextWidth - 15, chartY + 22);

  ctx.restore();

  // Chart line bounding box (leave room for header)
  const graphX = chartX + 15;
  const graphY = chartY + 32;
  const graphW = chartW - 30;
  const graphH = chartH - 42;

  const eleDiff = maxEle - minEle;
  const padding = eleDiff > 0 ? eleDiff * 0.15 : 10;
  const minLimit = minEle - padding;
  const maxLimit = maxEle + padding;
  const limitRange = maxLimit - minLimit;

  // Chart point helper
  function getGraphXY(index) {
    const pt = points[index];
    const x = graphX + (pt.dist / gpxData.totalDistance) * graphW;
    const y = graphY + graphH - ((pt.ele - minLimit) / limitRange) * graphH;
    return { x, y };
  }

  // 3. Draw Chart Gradient Fill
  ctx.beginPath();
  const graphStart = getGraphXY(0);
  ctx.moveTo(graphStart.x, graphStart.y);
  for (let i = 1; i < points.length; i++) {
    const pos = getGraphXY(i);
    ctx.lineTo(pos.x, pos.y);
  }
  ctx.lineTo(graphX + graphW, graphY + graphH);
  ctx.lineTo(graphX, graphY + graphH);
  ctx.closePath();

  const fillGradient = ctx.createLinearGradient(0, graphY, 0, graphY + graphH);
  fillGradient.addColorStop(0, hexToRgbA(activeColor, 0.25));
  fillGradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = fillGradient;
  ctx.fill();

  // 4. Draw Stroke Line
  ctx.beginPath();
  ctx.moveTo(graphStart.x, graphStart.y);
  for (let i = 1; i < points.length; i++) {
    const pos = getGraphXY(i);
    ctx.lineTo(pos.x, pos.y);
  }
  ctx.strokeStyle = activeColor;
  ctx.lineWidth = 2.0;
  ctx.stroke();

  // 5. Draw Time Indicator Line
  const curX = graphX + progress * graphW;
  ctx.beginPath();
  ctx.moveTo(curX, graphY);
  ctx.lineTo(curX, graphY + graphH);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.stroke();
  ctx.setLineDash([]);

  // 6. Draw Glow Dot
  const curY = graphY + graphH - ((curPt.ele - minLimit) / limitRange) * graphH;
  ctx.beginPath();
  ctx.arc(curX, curY, 5, 0, Math.PI * 2);
  ctx.fillStyle = hexToRgbA(activeColor, 0.4);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(curX, curY, 2.5, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  ctx.restore();
}

async function startRecordingFlow() {
  if (isPlaying) stopAnimation();
  
  isRecording = true;
  abortRecording = false;
  
  previewBtn.disabled = true;
  recordBtn.disabled = true;
  
  const durationSec = parseInt(durationInput.value, 10);
  const [rawWidth, rawHeight] = resolutionSelect.value.split('x').map(num => parseInt(num, 10));
  // H.264 하드웨어 가속 인코딩 호환성을 위해 가로, 세로 해상도를 16의 배수로 강제 올림 조정
  const width = Math.ceil(rawWidth / 16) * 16;
  const height = Math.ceil(rawHeight / 16) * 16;
  const cameraMode = document.querySelector('input[name="camera-mode"]:checked').value;
  
  renderingOverlay.classList.remove('hidden');
  progressBarFill.style.width = '0%';
  progressText.textContent = '0';
  
  // Apply resolution size to viewport
  mapViewport.classList.add('recording-mode');
  mapViewport.style.width = `${width}px`;
  mapViewport.style.height = `${height}px`;
  
  const scaleX = (window.innerWidth - 80) / width;
  const scaleY = (window.innerHeight - 80) / height;
  const scale = Math.min(1, scaleX, scaleY);
  
  if (scale < 1) {
    mapViewport.style.transform = `translate(-50%, -50%) scale(${scale})`;
    mapViewport.style.transformOrigin = 'center center';
    mapViewport.style.position = 'fixed';
    mapViewport.style.top = '50%';
    mapViewport.style.left = '50%';
  } else {
    mapViewport.style.transform = 'none';
    mapViewport.style.position = 'absolute';
    mapViewport.style.top = '0';
    mapViewport.style.left = '0';
  }
  
  map.resize();
  
  // Hide native HTML elevation overlay during recording, since it will be drawn to composite canvas instead
  elevationPanel.classList.add('hidden');
  
  await new Promise(resolve => setTimeout(resolve, 800));

  // Create or resize composite canvas
  compositeCanvas = document.createElement('canvas');
  compositeCanvas.width = width;
  compositeCanvas.height = height;
  compositeCanvas.style.position = 'fixed';
  compositeCanvas.style.left = '-9999px';
  compositeCanvas.style.top = '-9999px';
  compositeCanvas.style.pointerEvents = 'none';
  document.body.appendChild(compositeCanvas);
  compositeCtx = compositeCanvas.getContext('2d');

  // Set 60 FPS as requested
  const fps = 60;

  // Update UI Message with current FPS info
  const msgEl = document.querySelector('.rendering-message');
  msgEl.textContent = `지도를 가리거나 크기를 조절하지 마세요. (60 FPS)`;

  const useWebCodecs = typeof window.VideoEncoder !== 'undefined' && typeof window.Mp4Muxer !== 'undefined';

  function setupMediaRecorderFallback() {
    let options = { mimeType: 'video/webm;codecs=vp9' };
    if (!MediaRecorder.isTypeSupported(options.mimeType)) {
      options = { mimeType: 'video/webm;codecs=vp8' };
      if (!MediaRecorder.isTypeSupported(options.mimeType)) {
        options = { mimeType: 'video/webm' };
        if (!MediaRecorder.isTypeSupported(options.mimeType)) {
          options = { mimeType: 'video/mp4' };
        }
      }
    }

    let stream;
    try {
      stream = compositeCanvas.captureStream(fps);
    } catch (err) {
      console.error("Stream capture failed: ", err);
      alert("Canvas 캡처를 지원하지 않는 브라우저이거나 보안 문제가 발생했습니다.");
      stopRecordingFlowCleanUp();
      return;
    }

    recordedChunks = [];
    try {
      mediaRecorder = new MediaRecorder(stream, options);
    } catch (e) {
      mediaRecorder = new MediaRecorder(stream);
    }

    mediaRecorder.onerror = (event) => {
      console.error("MediaRecorder Error:", event.error);
      alert("녹화 중 오류가 발생했습니다: " + (event.error ? event.error.message : "알 수 없는 오류"));
      stopRecordingFlowCleanUp();
    };

    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        recordedChunks.push(event.data);
      }
    };

    mediaRecorder.onstop = () => {
      if (abortRecording) {
        recordedChunks = [];
        return;
      }
      
      const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      
      a.href = url;
      a.download = `gpx_motion_recording.mp4`; // Always save as mp4 extension
      document.body.appendChild(a);
      a.click();
      
      setTimeout(() => {
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
      }, 100);

      stopRecordingFlowCleanUp();
    };

    mediaRecorder.start();
  }

  let actualUseWebCodecs = useWebCodecs;

  if (useWebCodecs) {
    try {
      // WebCodecs configuration verification
      const candidateCodecs = [
        'avc1.4d401f', // H.264 Main Profile, Level 3.1
        'avc1.42e01f', // H.264 Baseline Profile, Level 3.1
        'avc1.64001f', // H.264 High Profile, Level 3.1
        'avc1.4d001f', // H.264 Main Profile, Level 3.1 (Alt)
        'avc1.42001e', // H.264 Constrained Baseline, Level 3.0
        'avc1.640028'  // H.264 High Profile, Level 4.0
      ];

      let selectedCodec = null;
      
      // Async helper to find best supported codec
      async function configureEncoder() {
        for (const codec of candidateCodecs) {
          try {
            const support = await VideoEncoder.isConfigSupported({
              codec: codec,
              width: width,
              height: height,
              bitrate: 5_000_000,
              framerate: fps
            });
            if (support.supported) {
              selectedCodec = codec;
              break;
            }
          } catch (e) {
            // ignore and try next
          }
        }

        if (!selectedCodec) {
          throw new Error("브라우저에서 지원하는 적절한 H.264 비디오 코덱을 찾을 수 없습니다.");
        }

        mp4Muxer = new Mp4Muxer.Muxer({
          target: new Mp4Muxer.ArrayBufferTarget(),
          video: {
            codec: 'avc',
            width: width,
            height: height
          },
          fastStart: 'in-memory'
        });

        videoEncoder = new VideoEncoder({
          output: (chunk, meta) => {
            if (mp4Muxer) mp4Muxer.addVideoChunk(chunk, meta);
          },
          error: e => {
            console.error("WebCodecs Encoder Error:", e);
            alert(`비디오 인코딩 중 에러가 발생했습니다: ${e.message || e}`);
            abortRecording = true;
            stopRecordingFlowCleanUp();
          }
        });

        videoEncoder.configure({
          codec: selectedCodec,
          width: width,
          height: height,
          bitrate: 5_000_000,
          framerate: fps
        });
      }

      await configureEncoder();
    } catch (err) {
      console.error("WebCodecs initialization failed, falling back to MediaRecorder:", err);
      actualUseWebCodecs = false;
      setupMediaRecorderFallback();
    }
  } else {
    setupMediaRecorderFallback();
  }

  runDeterministicRecordingLoop(durationSec, cameraMode, width, height, fps, actualUseWebCodecs);
}

async function runDeterministicRecordingLoop(durationSec, cameraMode, mapW, mapH, fps, useWebCodecs) {
  const totalFrames = durationSec * fps;
  let currentFrame = 0;

  const startPt = gpxData.points[0];
  const initialBearing = calculateBearing(startPt.lat, startPt.lon, gpxData.points[1].lat, gpxData.points[1].lon);
  
  const targetPitch = (cameraMode === 'chase-rot' || cameraMode === 'chase-fixed') ? 55 : 0;
  const targetBearing = cameraMode === 'chase-rot' ? initialBearing : 0;
  
  lastBearing = null; // Reset bearing smoothing

  const canvas = map.getCanvas();
  const isVertical = canvas.height > canvas.width;
  const targetZoom = (cameraMode === 'chase-rot' || cameraMode === 'chase-fixed') 
    ? (isVertical ? 13.5 : 14.5) 
    : (isVertical ? 11.5 : 13);

  map.jumpTo({
    center: [startPt.lon, startPt.lat],
    zoom: targetZoom,
    pitch: targetPitch,
    bearing: targetBearing
  });

  await waitForMapStyleAndTiles();

  while (currentFrame <= totalFrames && !abortRecording) {
    const progress = currentFrame / totalFrames;
    
    // Update map simulation
    updateSimulationFrame(progress, cameraMode);
    
    // Wait for map renderer to completely finish loading tiles for this frame
    await waitForMapStyleAndTiles();
    
    // Composite Frame:
    // 1. Draw Map WebGL Canvas
    compositeCtx.drawImage(map.getCanvas(), 0, 0, mapW, mapH);
    
    // 2. Draw Elevation Profile overlay on top
    drawElevationChartOnComposite(compositeCtx, mapW, mapH, progress);
    
    if (useWebCodecs && videoEncoder) {
      try {
        const timestampUs = Math.round((currentFrame / fps) * 1000000);
        const frame = new VideoFrame(compositeCanvas, { timestamp: timestampUs });
        const keyFrame = currentFrame % (fps * 2) === 0;
        videoEncoder.encode(frame, { keyFrame });
        frame.close();
      } catch (err) {
        console.error("Frame encode error: ", err);
      }
    }
    
    // Update UI Progress bar
    const pct = Math.round(progress * 100);
    progressBarFill.style.width = `${pct}%`;
    progressText.textContent = pct;

    currentFrame++;
    
    // Control queue size to prevent browser freeze and optimize speed
    if (useWebCodecs && videoEncoder) {
      if (videoEncoder.encodeQueueSize > 12) {
        await new Promise(r => setTimeout(r, 15)); // 큐가 쌓였을 때만 적절히 대기
      } else {
        await new Promise(r => setTimeout(r, 1));  // 큐가 여유 있을 때는 초고속 루프 진행
      }
    } else {
      // MediaRecorder 폴백 모드 시 실시간 속도에 맞추어 딜레이 적용 (예: 60fps -> 프레임당 약 16.6ms 대기)
      await new Promise(r => setTimeout(r, 1000 / fps));
    }
  }

  if (useWebCodecs && videoEncoder) {
    try {
      await videoEncoder.flush();
      videoEncoder.close();
      videoEncoder = null;
      
      mp4Muxer.finalize();
      
      if (!abortRecording) {
        const { buffer } = mp4Muxer.target;
        const blob = new Blob([buffer], { type: 'video/mp4' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `gpx_motion_recording.mp4`;
        document.body.appendChild(a);
        a.click();
        
        setTimeout(() => {
          document.body.removeChild(a);
          window.URL.revokeObjectURL(url);
        }, 100);
      }
      
      mp4Muxer = null;
      stopRecordingFlowCleanUp();
    } catch (err) {
      console.error("MP4 Muxing finalize error: ", err);
      alert("MP4 비디오 파일 작성 중 에러가 발생했습니다.");
      stopRecordingFlowCleanUp();
    }
  } else {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
  }
}

function waitForMapStyleAndTiles() {
  return new Promise((resolve) => {
    if (map.loaded()) {
      resolve();
      return;
    }
    
    let isResolved = false;
    const done = () => {
      if (!isResolved) {
        isResolved = true;
        resolve();
      }
    };

    map.once('idle', done);
    
    // 최대 12ms만 기다리고 강제로 프레임 캡처 진행 (속도 추가 향상 및 화면 품질 벨런스 확보)
    setTimeout(done, 12);
  });
}

function stopRecordingFlowCleanUp() {
  isRecording = false;
  previewBtn.disabled = false;
  recordBtn.disabled = false;
  
  renderingOverlay.classList.add('hidden');
  
  // Revert HTML overlay state
  elevationPanel.classList.remove('hidden');
  
  mapViewport.classList.remove('recording-mode');
  mapViewport.style.width = '100%';
  mapViewport.style.height = '100%';
  mapViewport.style.transform = 'none';
  mapViewport.style.transformOrigin = 'unset';
  mapViewport.style.position = 'absolute';
  mapViewport.style.top = '0';
  mapViewport.style.left = '0';
  
  map.resize();
  
  zoomToFitRoute();
  drawElevationChart(currentProgress);

  if (compositeCanvas && compositeCanvas.parentNode) {
    compositeCanvas.parentNode.removeChild(compositeCanvas);
    compositeCanvas = null;
  }
}

cancelRecordBtn.addEventListener('click', () => {
  abortRecording = true;
  if (videoEncoder) {
    try {
      videoEncoder.close();
    } catch (e) {}
    videoEncoder = null;
    mp4Muxer = null;
  }
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  stopRecordingFlowCleanUp();
});

window.addEventListener('DOMContentLoaded', () => {
  initMap();
  setupEvents();
});
