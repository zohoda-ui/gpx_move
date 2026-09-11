/**
 * Runruun Standard GPX & Elevation Engine
 * Spatial Gaussian Filtering, Gradient Spike Limiter, Deadband Elevation Accumulation,
 * Copernicus DEM GLO-30 (30m) lookup, Extensible Profile Architecture (Road / Trail),
 * robust XML & Regex parsing fallback, and GitHub GPX caching.
 */
(function (global) {
  'use strict';

  // In-memory cache for fast repeated lookups
  const memoryCache = new Map();

  // Registered Elevation Profiles
  const PROFILES = {
    trail: {
      key: 'trail',
      name: '트레일러닝 (Trail Profile)',
      repository: 'gpx',
      description: '트레일 전용: 공간 가우시안 필터 (Sigma 15m), 경사도 45% 제한, 데드밴드 2.0m',
      resampleIntervalMeters: 5.0,
      maxSlopeGradient: 0.45,
      gaussianSigmaMeters: 15.0,
      deadbandMeters: 2.0,
      hysteresisThresholdMeters: 2.0,
      minChangeDistanceMeters: 10.0,
      medianWindow: 3,
      sgWindow: 9,
      smoothingWindow: 3
    },
    road: {
      key: 'road',
      name: '로드마라톤 (Road Profile)',
      repository: 'gpx-road',
      description: '로드마라톤 전용: 공간 가우시안 필터 (Sigma 35m), 경사도 15% 제한, 데드밴드 3.0m',
      resampleIntervalMeters: 10.0,
      maxSlopeGradient: 0.15,
      gaussianSigmaMeters: 35.0,
      deadbandMeters: 3.0,
      hysteresisThresholdMeters: 3.0,
      minChangeDistanceMeters: 20.0,
      medianWindow: 5,
      sgWindow: 11,
      smoothingWindow: 5
    }
  };

  function simpleHash(str) {
    let hash = 0;
    if (!str || str.length === 0) return '0';
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0;
    }
    return 'h_' + Math.abs(hash);
  }

  function getCachedResult(key) {
    if (memoryCache.has(key)) {
      return memoryCache.get(key);
    }
    if (typeof sessionStorage !== 'undefined') {
      try {
        const stored = sessionStorage.getItem('rr_gpx_cache_' + key);
        if (stored) {
          const parsed = JSON.parse(stored);
          memoryCache.set(key, parsed);
          return parsed;
        }
      } catch (e) {}
    }
    return null;
  }

  function setCachedResult(key, data) {
    memoryCache.set(key, data);
    if (typeof sessionStorage !== 'undefined') {
      try {
        sessionStorage.setItem('rr_gpx_cache_' + key, JSON.stringify(data));
      } catch (e) {}
    }
  }

  function convertGithubUrl(rawUrl) {
    if (!rawUrl) return rawUrl;
    let url = rawUrl.trim();
    if (url.includes('github.com') && url.includes('/blob/')) {
      url = url.replace('github.com', 'raw.githubusercontent.com').replace('/blob/', '/');
    }
    return url;
  }

  function detectProfileFromUrlOrName(urlOrName, explicitProfile) {
    if (explicitProfile && PROFILES[explicitProfile]) {
      return explicitProfile;
    }
    if (!urlOrName) return 'trail';

    const str = String(urlOrName).toLowerCase();
    
    for (const key of Object.keys(PROFILES)) {
      if (str.includes('gpx-' + key) || str.includes('/gpx-' + key + '/')) {
        return key;
      }
    }

    if (str.includes('/gpx-road/') || str.includes('gpx-road')) {
      return 'road';
    }
    if (str.includes('/gpx/') || str.includes('trail') || str.includes('gpx')) {
      return 'trail';
    }

    return 'trail';
  }

  const RunruunElevationEngine = {
    PROFILES: PROFILES,

    registerProfile: function (key, config) {
      if (!key || !config) return;
      PROFILES[key] = {
        key: key,
        name: config.name || `${key} Profile`,
        description: config.description || '',
        resampleIntervalMeters: config.resampleIntervalMeters || 10.0,
        maxSlopeGradient: config.maxSlopeGradient || 0.15,
        gaussianSigmaMeters: config.gaussianSigmaMeters || 35.0,
        deadbandMeters: config.deadbandMeters || 3.0,
        hysteresisThresholdMeters: config.hysteresisThresholdMeters || 3.0,
        smoothingWindow: config.smoothingWindow || 5
      };
    },

    detectProfile: detectProfileFromUrlOrName,

    fillMissingElevations: function (elevationArray) {
      if (!elevationArray || elevationArray.length === 0) return [];

      const n = elevationArray.length;
      const result = new Array(n);

      const isValid = new Array(n).fill(false);
      for (let i = 0; i < n; i++) {
        const val = elevationArray[i];
        if (val !== null && val !== undefined && !isNaN(val)) {
          isValid[i] = true;
        }
      }

      let validNonZeroSum = 0;
      let validNonZeroCount = 0;
      for (let i = 0; i < n; i++) {
        if (isValid[i] && elevationArray[i] !== 0) {
          validNonZeroSum += elevationArray[i];
          validNonZeroCount++;
        }
      }
      const avgValidEle = validNonZeroCount > 0 ? (validNonZeroSum / validNonZeroCount) : 0;

      for (let i = 0; i < n; i++) {
        if (isValid[i] && elevationArray[i] === 0) {
          let prevVal = null;
          for (let p = i - 1; p >= 0; p--) {
            if (isValid[p] && elevationArray[p] !== 0) { prevVal = elevationArray[p]; break; }
          }
          let nextVal = null;
          for (let nx = i + 1; nx < n; nx++) {
            if (isValid[nx] && elevationArray[nx] !== 0) { nextVal = elevationArray[nx]; break; }
          }

          const refNeighbor = (nextVal !== null) ? nextVal : ((prevVal !== null) ? prevVal : avgValidEle);
          if (Math.abs(refNeighbor) > 20 && Math.abs(refNeighbor - 0) > 20) {
            isValid[i] = false;
          }
        }
      }

      const validIndices = [];
      for (let i = 0; i < n; i++) {
        if (isValid[i]) {
          validIndices.push(i);
        }
      }

      if (validIndices.length === 0) {
        return new Array(n).fill(null);
      }

      const firstValidIdx = validIndices[0];
      const firstValidVal = elevationArray[firstValidIdx];
      for (let i = 0; i <= firstValidIdx; i++) {
        result[i] = firstValidVal;
      }

      for (let k = 0; k < validIndices.length - 1; k++) {
        const idxA = validIndices[k];
        const idxB = validIndices[k + 1];
        const valA = elevationArray[idxA];
        const valB = elevationArray[idxB];
        const steps = idxB - idxA;

        for (let i = idxA; i <= idxB; i++) {
          const ratio = (i - idxA) / steps;
          result[i] = Math.round((valA + (valB - valA) * ratio) * 10) / 10;
        }
      }

      const lastValidIdx = validIndices[validIndices.length - 1];
      const lastValidVal = elevationArray[lastValidIdx];
      for (let i = lastValidIdx; i < n; i++) {
        result[i] = lastValidVal;
      }

      return result;
    },

    haversineDistanceMeters: function (lat1, lon1, lat2, lon2) {
      const R = 6371000;
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLon = (lon2 - lon1) * Math.PI / 180;
      const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                Math.sin(dLon / 2) * Math.sin(dLon / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      return R * c;
    },

    haversineDistanceKm: function (lat1, lon1, lat2, lon2) {
      return this.haversineDistanceMeters(lat1, lon1, lat2, lon2) / 1000;
    },

    resamplePoints: function (points, targetIntervalMeters = 10.0) {
      if (!points || points.length === 0) return [];

      const rawEles = points.map(p => p ? p.ele : null);
      const filledEles = this.fillMissingElevations(rawEles);

      const getEle = (idx) => (filledEles[idx] !== undefined ? filledEles[idx] : 0);

      if (points.length === 1) {
        return [{
          lat: points[0].lat,
          lon: points[0].lon,
          ele: getEle(0),
          dist: 0,
          originalEle: points[0].originalEle !== undefined ? points[0].originalEle : (points[0].ele || null)
        }];
      }

      const cumulativeDist = [0];
      let totalDistMeters = 0;
      for (let i = 1; i < points.length; i++) {
        const d = this.haversineDistanceMeters(
          points[i - 1].lat, points[i - 1].lon,
          points[i].lat, points[i].lon
        );
        totalDistMeters += d;
        cumulativeDist.push(totalDistMeters);
      }

      const resampled = [];
      resampled.push({
        lat: points[0].lat,
        lon: points[0].lon,
        ele: Math.round(getEle(0) * 10) / 10,
        dist: 0,
        originalEle: points[0].originalEle !== undefined ? points[0].originalEle : (points[0].ele || null)
      });

      let currentTargetDist = targetIntervalMeters;
      let rawIdx = 0;

      while (currentTargetDist < totalDistMeters) {
        while (rawIdx < points.length - 1 && cumulativeDist[rawIdx + 1] < currentTargetDist) {
          rawIdx++;
        }

        if (rawIdx >= points.length - 1) break;

        const dStart = cumulativeDist[rawIdx];
        const dEnd = cumulativeDist[rawIdx + 1];
        const segLen = dEnd - dStart;

        const ratio = segLen > 0 ? (currentTargetDist - dStart) / segLen : 0;
        const latA = points[rawIdx].lat;
        const lonA = points[rawIdx].lon;
        const eleA = getEle(rawIdx);
        const origEleA = points[rawIdx].originalEle !== undefined ? points[rawIdx].originalEle : (points[rawIdx].ele || null);

        const latB = points[rawIdx + 1].lat;
        const lonB = points[rawIdx + 1].lon;
        const eleB = getEle(rawIdx + 1);
        const origEleB = points[rawIdx + 1].originalEle !== undefined ? points[rawIdx + 1].originalEle : (points[rawIdx + 1].ele || null);

        const interpLat = latA + (latB - latA) * ratio;
        const interpLon = lonA + (lonB - lonA) * ratio;
        const interpEle = eleA + (eleB - eleA) * ratio;
        const interpOrigEle = ratio < 0.5 ? origEleA : origEleB;

        resampled.push({
          lat: interpLat,
          lon: interpLon,
          ele: Math.round(interpEle * 10) / 10,
          dist: Math.round((currentTargetDist / 1000) * 10000) / 10000,
          originalEle: interpOrigEle
        });

        currentTargetDist += targetIntervalMeters;
      }

      const lastIdx = points.length - 1;
      const lastRaw = points[lastIdx];
      const lastEle = getEle(lastIdx);
      resampled.push({
        lat: lastRaw.lat,
        lon: lastRaw.lon,
        ele: Math.round(lastEle * 10) / 10,
        dist: Math.round((totalDistMeters / 1000) * 10000) / 10000,
        originalEle: lastRaw.originalEle !== undefined ? lastRaw.originalEle : (lastRaw.ele || null)
      });

      return resampled;
    },

    limitGradientSpikes: function (points, maxSlopeGradient = 0.15) {
      if (!points || points.length <= 1) return points;
      const n = points.length;
      const result = points.map(p => ({ ...p }));

      for (let i = 1; i < n; i++) {
        const pPrev = result[i - 1];
        const pCur = result[i];
        const dd = this.haversineDistanceMeters(pPrev.lat, pPrev.lon, pCur.lat, pCur.lon);
        if (dd <= 0) continue;

        const dh = pCur.ele - pPrev.ele;
        const maxDh = (maxSlopeGradient * dd) + 0.3;

        if (Math.abs(dh) > maxDh) {
          result[i].ele = Math.round((pPrev.ele + Math.sign(dh) * maxDh) * 10) / 10;
        }
      }
      return result;
    },

    spatialGaussianSmooth: function (points, sigmaMeters = 35.0, resampleStepMeters = 10.0) {
      if (!points || points.length <= 2 || sigmaMeters <= 0) return points;

      const n = points.length;
      const sigmaPts = Math.max(0.5, sigmaMeters / resampleStepMeters);
      const kernelRadius = Math.ceil(3 * sigmaPts);
      const kernelSize = 2 * kernelRadius + 1;

      const kernel = new Float64Array(kernelSize);
      let kernelSum = 0;
      for (let i = 0; i < kernelSize; i++) {
        const x = i - kernelRadius;
        const val = Math.exp(-0.5 * (x / sigmaPts) * (x / sigmaPts));
        kernel[i] = val;
        kernelSum += val;
      }
      for (let i = 0; i < kernelSize; i++) {
        kernel[i] /= kernelSum;
      }

      const result = points.map(p => ({ ...p }));

      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let k = -kernelRadius; k <= kernelRadius; k++) {
          let idx = i + k;
          if (idx < 0) idx = 0;
          else if (idx >= n) idx = n - 1;
          sum += points[idx].ele * kernel[k + kernelRadius];
        }
        result[i].ele = Math.round(sum * 10) / 10;
      }

      return result;
    },

    calculateStats: function (points, profileKey = 'road', rawDistanceKm = null) {
      if (!points || points.length === 0) {
        return {
          totalDist: 0,
          rawTotalDistKm: 0,
          eleGain: 0,
          eleLoss: 0,
          minEle: 0,
          maxEle: 0,
          vkm: 0,
          profile: profileKey,
          chartData: []
        };
      }

      const profile = PROFILES[profileKey] || PROFILES.road;
      const deadband = profile.deadbandMeters || 3.0;

      let minEle = points[0].ele;
      let maxEle = points[0].ele;

      for (let i = 0; i < points.length; i++) {
        const val = points[i].ele;
        if (val < minEle) minEle = val;
        if (val > maxEle) maxEle = val;
      }

      const distArrayMeters = [0];
      let runningDistMeters = 0;
      for (let i = 1; i < points.length; i++) {
        if (points[i].dist !== undefined && points[i - 1].dist !== undefined) {
          runningDistMeters = points[i].dist * 1000;
        } else {
          runningDistMeters += this.haversineDistanceMeters(
            points[i - 1].lat, points[i - 1].lon,
            points[i].lat, points[i].lon
          );
        }
        distArrayMeters.push(runningDistMeters);
      }

      const totalDistMeters = distArrayMeters[distArrayMeters.length - 1];
      const totalDistKm = (rawDistanceKm !== null && rawDistanceKm > 0) ? rawDistanceKm : (totalDistMeters / 1000);

      let eleGain = 0;
      let eleLoss = 0;
      let minTrackElev = points[0].ele;
      let maxTrackElev = points[0].ele;
      let direction = 0;

      for (let i = 1; i < points.length; i++) {
        const cur = points[i].ele;

        if (direction === 0) {
          if (cur - minTrackElev >= deadband) {
            eleGain += (cur - minTrackElev);
            maxTrackElev = cur;
            direction = 1;
          } else if (maxTrackElev - cur >= deadband) {
            eleLoss += (maxTrackElev - cur);
            minTrackElev = cur;
            direction = -1;
          }
        } else if (direction === 1) {
          if (cur > maxTrackElev) {
            eleGain += (cur - maxTrackElev);
            maxTrackElev = cur;
          } else if (maxTrackElev - cur >= deadband) {
            eleLoss += (maxTrackElev - cur);
            minTrackElev = cur;
            direction = -1;
          }
        } else if (direction === -1) {
          if (cur < minTrackElev) {
            eleLoss += (minTrackElev - cur);
            minTrackElev = cur;
          } else if (cur - minTrackElev >= deadband) {
            eleGain += (cur - minTrackElev);
            maxTrackElev = cur;
            direction = 1;
          }
        }
      }

      const vkm = totalDistKm > 0 ? (eleGain / totalDistKm) : 0;

      let accumDist = 0;
      const chartData = points.map((p, idx) => {
        accumDist = distArrayMeters[idx] / 1000;
        return {
          x: Math.round(accumDist * 100) / 100,
          y: Math.round(p.ele * 10) / 10,
          lat: p.lat,
          lon: p.lon
        };
      });

      return {
        totalDist: Math.round(totalDistKm * 10) / 10,
        rawTotalDistKm: totalDistKm,
        eleGain: Math.round(eleGain),
        eleLoss: Math.round(eleLoss),
        minEle: Math.round(minEle * 10) / 10,
        maxEle: Math.round(maxEle * 10) / 10,
        vkm: Math.round(vkm * 10) / 10,
        profile: profile.key,
        profileName: profile.name,
        chartData
      };
    },

    /**
     * 모바일 / 웹킷 / 다양한 XML 및 정규식 폴백을 지원하는 견고한 GPX 파서
     */
    parseGpx: function (gpxText) {
      if (!gpxText || typeof gpxText !== 'string') {
        throw new Error('GPX 데이터가 비어있거나 올바르지 않습니다.');
      }

      const points = [];

      // 1. DOMParser XML 파싱 시도
      try {
        if (typeof DOMParser !== 'undefined') {
          const parser = new DOMParser();
          const xmlDoc = parser.parseFromString(gpxText.trim(), "text/xml");

          const parserError = xmlDoc.getElementsByTagName("parsererror");
          if (!parserError || parserError.length === 0 || xmlDoc.documentElement.nodeName !== "parsererror") {
            let trkpts = xmlDoc.getElementsByTagNameNS ? xmlDoc.getElementsByTagNameNS("*", "trkpt") : null;
            if (!trkpts || trkpts.length === 0) trkpts = xmlDoc.getElementsByTagName("trkpt");
            if (!trkpts || trkpts.length === 0) trkpts = xmlDoc.getElementsByTagNameNS ? xmlDoc.getElementsByTagNameNS("*", "rtept") : null;
            if (!trkpts || trkpts.length === 0) trkpts = xmlDoc.getElementsByTagName("rtept");
            if (!trkpts || trkpts.length === 0) trkpts = xmlDoc.getElementsByTagNameNS ? xmlDoc.getElementsByTagNameNS("*", "wpt") : null;
            if (!trkpts || trkpts.length === 0) trkpts = xmlDoc.getElementsByTagName("wpt");

            if (trkpts && trkpts.length > 0) {
              for (let i = 0; i < trkpts.length; i++) {
                const pt = trkpts[i];
                const latAttr = pt.getAttribute('lat') || pt.getAttribute('Lat') || pt.getAttribute('LAT');
                const lonAttr = pt.getAttribute('lon') || pt.getAttribute('Lon') || pt.getAttribute('LON') || pt.getAttribute('lng') || pt.getAttribute('Lng');
                if (!latAttr || !lonAttr) continue;

                const lat = parseFloat(latAttr);
                const lon = parseFloat(lonAttr);
                if (isNaN(lat) || isNaN(lon)) continue;

                let ele = null;
                const eleNodes = pt.getElementsByTagNameNS ? pt.getElementsByTagNameNS("*", "ele") : null;
                if (eleNodes && eleNodes.length > 0) {
                  ele = parseFloat(eleNodes[0].textContent);
                } else {
                  const plainEleNodes = pt.getElementsByTagName("ele");
                  if (plainEleNodes && plainEleNodes.length > 0) {
                    ele = parseFloat(plainEleNodes[0].textContent);
                  }
                }

                if (isNaN(ele)) ele = null;
                points.push({ lat, lon, ele });
              }
            }
          }
        }
      } catch (domErr) {
        console.warn('[GPX Engine] XML DOMParser 파싱 예외 발생, 정규식 파서로 전환:', domErr);
      }

      // 2. 모바일 브라우저 XML 파싱 실패 또는 미지원 시 정규식(Regex) 안전 폴백
      if (points.length === 0) {
        // Tag with body: <trkpt lat=".." lon="..">...</trkpt>
        const ptRegex = /<(?:trkpt|rtept|wpt)[^>]*?(?:lat=["']([^"']+)["'][^>]*?lon=["']([^"']+)["']|lon=["']([^"']+)["'][^>]*?lat=["']([^"']+)["'])[^>]*>([\s\S]*?)<\/(?:trkpt|rtept|wpt)>/gi;
        // Self-closing tag: <trkpt lat=".." lon=".." />
        const selfClosingRegex = /<(?:trkpt|rtept|wpt)[^>]*?(?:lat=["']([^"']+)["'][^>]*?lon=["']([^"']+)["']|lon=["']([^"']+)["'][^>]*?lat=["']([^"']+)["'])[^>]*\/>/gi;
        const eleRegex = /<ele[^>]*>([^<]+)<\/ele>/i;

        let match;
        while ((match = ptRegex.exec(gpxText)) !== null) {
          const latVal = match[1] !== undefined ? match[1] : match[4];
          const lonVal = match[2] !== undefined ? match[2] : match[3];
          const lat = parseFloat(latVal);
          const lon = parseFloat(lonVal);
          if (isNaN(lat) || isNaN(lon)) continue;

          let ele = null;
          const body = match[5];
          if (body) {
            const eleMatch = eleRegex.exec(body);
            if (eleMatch) {
              ele = parseFloat(eleMatch[1]);
              if (isNaN(ele)) ele = null;
            }
          }
          points.push({ lat, lon, ele });
        }

        if (points.length === 0) {
          while ((match = selfClosingRegex.exec(gpxText)) !== null) {
            const latVal = match[1] !== undefined ? match[1] : match[4];
            const lonVal = match[2] !== undefined ? match[2] : match[3];
            const lat = parseFloat(latVal);
            const lon = parseFloat(lonVal);
            if (isNaN(lat) || isNaN(lon)) continue;
            points.push({ lat, lon, ele: null });
          }
        }
      }

      if (points.length === 0) {
        throw new Error('GPX 파일 내에 유효한 GPS 좌표(trkpt/rtept/wpt) 데이터가 없습니다.');
      }

      return points;
    },

    exportGpx: function (points, trackName = 'Runruun Course') {
      const rawEles = points.map(p => p ? p.ele : null);
      const filledEles = this.fillMissingElevations(rawEles);

      let gpx = `<?xml version="1.0" encoding="UTF-8"?>\n`;
      gpx += `<gpx version="1.1" creator="Runruun Standard GPX Engine" xmlns="http://www.topografix.com/GPX/1/1">\n`;
      gpx += `  <metadata>\n    <name>${escapeXml(trackName)}</name>\n  </metadata>\n`;
      gpx += `  <trk>\n    <name>${escapeXml(trackName)}</name>\n    <trkseg>\n`;

      for (let i = 0; i < points.length; i++) {
        const pt = points[i];
        const eleVal = filledEles[i].toFixed(1);
        gpx += `      <trkpt lat="${pt.lat.toFixed(6)}" lon="${pt.lon.toFixed(6)}">\n`;
        gpx += `        <ele>${eleVal}</ele>\n`;
        gpx += `      </trkpt>\n`;
      }

      gpx += `    </trkseg>\n  </trk>\n</gpx>`;
      return gpx;
    },

    fetchCopernicusElevations: async function (points, options = {}) {
      if (!points || points.length === 0) return points;

      const signal = options && options.signal ? options.signal : undefined;
      const coords = points.map(p => ({ lat: p.lat, lon: p.lon }));
      const elevations = new Array(coords.length).fill(null);
      const BATCH_SIZE = 50;

      for (let i = 0; i < coords.length; i += BATCH_SIZE) {
        if (signal && signal.aborted) break;
        const batch = coords.slice(i, i + BATCH_SIZE);
        const lats = batch.map(c => c.lat.toFixed(6)).join(',');
        const lons = batch.map(c => c.lon.toFixed(6)).join(',');

        let batchSuccess = false;

        try {
          const url = `https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lons}`;
          const res = await fetch(url, { signal });
          if (res.ok) {
            const data = await res.json();
            if (data && Array.isArray(data.elevation)) {
              for (let j = 0; j < Math.min(data.elevation.length, batch.length); j++) {
                if (data.elevation[j] !== null && data.elevation[j] !== undefined && !isNaN(data.elevation[j])) {
                  elevations[i + j] = Math.round(data.elevation[j] * 10) / 10;
                }
              }
              const validInBatch = elevations.slice(i, i + batch.length).filter(e => e !== null).length;
              batchSuccess = validInBatch > 0;
            }
          }
        } catch (err) {}

        if (!batchSuccess) {
          try {
            const locStr = batch.map(c => `${c.lat.toFixed(6)},${c.lon.toFixed(6)}`).join('|');
            const backupUrl = `https://api.opentopodata.org/v1/srtm30m?locations=${locStr}`;
            const res = await fetch(backupUrl, { signal });
            if (res.ok) {
              const data = await res.json();
              if (data && data.status === "OK" && Array.isArray(data.results)) {
                for (let j = 0; j < Math.min(data.results.length, batch.length); j++) {
                  const ele = data.results[j].elevation;
                  if (ele !== null && ele !== undefined && !isNaN(ele)) {
                    elevations[i + j] = Math.round(ele * 10) / 10;
                  }
                }
                batchSuccess = elevations.slice(i, i + batch.length).some(e => e !== null);
              }
            }
          } catch (backupErr) {}
        }
      }

      const existingEles = points.map(p => p ? p.ele : null);
      for (let i = 0; i < elevations.length; i++) {
        if (elevations[i] === null && existingEles[i] !== null && existingEles[i] !== undefined) {
          elevations[i] = existingEles[i];
        }
      }

      const filledElevations = this.fillMissingElevations(elevations);
      return points.map((p, idx) => ({
        ...p,
        ele: filledElevations[idx]
      }));
    },

    processGpx: async function (gpxText, options = {}) {
      const profileKey = detectProfileFromUrlOrName(options.url || options.filename, options.profile);
      const profile = PROFILES[profileKey] || PROFILES.road;

      const cacheKey = simpleHash(gpxText) + '_' + profileKey;
      if (!options.bypassCache) {
        const cached = getCachedResult(cacheKey);
        if (cached) return cached;
      }

      const forceDemFetch = options.forceDemFetch || false;
      const rawPoints = this.parseGpx(gpxText);

      // 1. 원본 GPX 좌표 기준 실제 거리 계산 (고도 smoothing과 독립적으로 보존)
      let rawDistMeters = 0;
      for (let i = 1; i < rawPoints.length; i++) {
        rawDistMeters += this.haversineDistanceMeters(
          rawPoints[i - 1].lat, rawPoints[i - 1].lon,
          rawPoints[i].lat, rawPoints[i].lon
        );
      }
      const rawDistanceKm = rawDistMeters / 1000;

      const hasElevations = rawPoints.every(p => p.ele !== null && !isNaN(p.ele));
      
      // 2. 등간격 리샘플링
      let finalPoints = this.resamplePoints(rawPoints, profile.resampleIntervalMeters);

      if (forceDemFetch || !hasElevations) {
        finalPoints = await this.fetchCopernicusElevations(finalPoints);
      }

      // 3. 물리적 경사도 한계 이상치 보정 (Gradient Spike Limiter)
      finalPoints = this.limitGradientSpikes(finalPoints, profile.maxSlopeGradient);

      // 4. 공간 가우시안 스무딩 (Spatial Gaussian Filter)
      finalPoints = this.spatialGaussianSmooth(finalPoints, profile.gaussianSigmaMeters, profile.resampleIntervalMeters);

      // 5. 데드밴드 피크-밸리 통계 계산 -> 거리, D+, D-, V/km 산출
      const stats = this.calculateStats(finalPoints, profileKey, rawDistanceKm);
      const result = { points: finalPoints, stats: stats, profile: profileKey, profileName: profile.name };

      setCachedResult(cacheKey, result);
      return result;
    },

    processGpxUrl: async function (rawUrl, options = {}) {
      const url = convertGithubUrl(rawUrl);
      const profileKey = detectProfileFromUrlOrName(url, options.profile);
      const cacheKey = 'url_' + simpleHash(url) + '_' + profileKey;

      if (!options.bypassCache) {
        const cached = getCachedResult(cacheKey);
        if (cached) return cached;
      }

      const res = await fetch(url);
      if (!res.ok) throw new Error(`GPX 다운로드 실패 (${res.status}): ${res.statusText}`);

      const gpxText = await res.text();
      const processed = await this.processGpx(gpxText, { ...options, profile: profileKey, url: url });
      const result = { ...processed, gpxText, url };

      setCachedResult(cacheKey, result);
      return result;
    },

    convertGithubUrl: convertGithubUrl,
    clearCache: function () {
      memoryCache.clear();
      if (typeof sessionStorage !== 'undefined') {
        try {
          Object.keys(sessionStorage).forEach(k => {
            if (k.startsWith('rr_gpx_cache_')) sessionStorage.removeItem(k);
          });
        } catch (e) {}
      }
    }
  };

  function escapeXml(unsafe) {
    return String(unsafe).replace(/[<>&'"]/g, function (c) {
      switch (c) {
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '&': return '&amp;';
        case '\'': return '&apos;';
        case '"': return '&quot;';
      }
    });
  }

  global.RunruunElevationEngine = RunruunElevationEngine;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
