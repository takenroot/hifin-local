/**
 * 看板欢迎区天气（Open-Meteo 免费 API，无需 key）
 * ---------------------------------------------------------------
 * - GET https://api.open-meteo.com/v1/forecast?latitude=&longitude=&current_weather=true
 * - 定位优先级：navigator.geolocation（3s 超时）→ kv 'weather.city'（默认北京）
 *
 * 缓存策略：stale-while-revalidate（SWR）
 * - 缓存有效期 2 小时（CACHE_TTL），落 kv 'weather.cache'
 * - 页面加载：getWeatherSync() 先把缓存画出来（超期也画，标记 isStale），
 *   紧接着 refreshWeather() 静默回源，成功后替换 —— 用户全程无空白等待。
 * - 城市切换：clearWeatherCache() 立即丢弃旧缓存（经纬度变了，旧值无意义），
 *   再 refreshWeather({ force: true }) 抓新城市的天气。
 * - 任何失败（离线/跨域/超时）返回 null，由 UI 保留当前已渲染的内容。
 */

import { apiFetch } from '@/hooks/useApi';

export interface CityPreset {
  name: string;
  lat: number;
  lon: number;
}

/** 全国 34 个省级行政区的主要城市（经纬度已核对） */
export const CITY_PRESETS: CityPreset[] = [
  // 直辖市
  { name: '北京', lat: 39.9042, lon: 116.4074 },
  { name: '上海', lat: 31.2304, lon: 121.4737 },
  { name: '天津', lat: 39.3434, lon: 117.3616 },
  { name: '重庆', lat: 29.5630, lon: 106.5516 },
  // 河北
  { name: '石家庄', lat: 38.0428, lon: 114.5149 },
  { name: '唐山', lat: 39.6305, lon: 118.1802 },
  // 山西
  { name: '太原', lat: 37.8706, lon: 112.5489 },
  { name: '大同', lat: 40.0903, lon: 113.2950 },
  // 内蒙古
  { name: '呼和浩特', lat: 40.8426, lon: 111.7492 },
  { name: '包头', lat: 40.6582, lon: 109.8403 },
  // 辽宁
  { name: '沈阳', lat: 41.8057, lon: 123.4315 },
  { name: '大连', lat: 38.9140, lon: 121.6147 },
  // 吉林
  { name: '长春', lat: 43.8171, lon: 125.3235 },
  { name: '吉林', lat: 43.8378, lon: 126.5494 },
  // 黑龙江
  { name: '哈尔滨', lat: 45.8038, lon: 126.5349 },
  { name: '大庆', lat: 46.5876, lon: 125.1030 },
  // 江苏
  { name: '南京', lat: 32.0603, lon: 118.7969 },
  { name: '苏州', lat: 31.2989, lon: 120.5853 },
  { name: '无锡', lat: 31.4912, lon: 120.3119 },
  // 浙江
  { name: '杭州', lat: 30.2741, lon: 120.1551 },
  { name: '宁波', lat: 29.8683, lon: 121.5440 },
  { name: '温州', lat: 27.9944, lon: 120.6994 },
  // 安徽
  { name: '合肥', lat: 31.8206, lon: 117.2272 },
  { name: '芜湖', lat: 31.3529, lon: 118.4331 },
  // 福建
  { name: '福州', lat: 26.0745, lon: 119.2965 },
  { name: '厦门', lat: 24.4798, lon: 118.0894 },
  { name: '泉州', lat: 24.8741, lon: 118.6757 },
  // 江西
  { name: '南昌', lat: 28.6820, lon: 115.8579 },
  { name: '赣州', lat: 25.8307, lon: 114.9350 },
  // 山东
  { name: '济南', lat: 36.6512, lon: 117.1201 },
  { name: '青岛', lat: 36.0671, lon: 120.3826 },
  { name: '烟台', lat: 37.4638, lon: 121.4479 },
  // 河南
  { name: '郑州', lat: 34.7466, lon: 113.6254 },
  { name: '洛阳', lat: 34.6197, lon: 112.4540 },
  // 湖北
  { name: '武汉', lat: 30.5928, lon: 114.3055 },
  { name: '宜昌', lat: 30.6919, lon: 111.2865 },
  // 湖南
  { name: '长沙', lat: 28.2282, lon: 112.9388 },
  { name: '株洲', lat: 27.8274, lon: 113.1338 },
  // 广东
  { name: '广州', lat: 23.1291, lon: 113.2644 },
  { name: '深圳', lat: 22.5431, lon: 114.0579 },
  { name: '珠海', lat: 22.2707, lon: 113.5767 },
  { name: '佛山', lat: 23.0215, lon: 113.1214 },
  { name: '东莞', lat: 23.0430, lon: 113.7518 },
  // 广西
  { name: '南宁', lat: 22.8170, lon: 108.3665 },
  { name: '桂林', lat: 25.2345, lon: 110.1794 },
  // 海南
  { name: '海口', lat: 20.0440, lon: 110.1999 },
  { name: '三亚', lat: 18.2528, lon: 109.5119 },
  // 四川
  { name: '成都', lat: 30.5728, lon: 104.0668 },
  { name: '绵阳', lat: 31.4675, lon: 104.6796 },
  { name: '宜宾', lat: 28.7513, lon: 104.6419 },
  // 贵州
  { name: '贵阳', lat: 26.6470, lon: 106.6302 },
  { name: '遵义', lat: 27.7257, lon: 106.9274 },
  // 云南
  { name: '昆明', lat: 24.8801, lon: 102.8329 },
  { name: '大理', lat: 25.6065, lon: 100.2679 },
  // 西藏
  { name: '拉萨', lat: 29.6520, lon: 91.1721 },
  // 陕西
  { name: '西安', lat: 34.3416, lon: 108.9398 },
  { name: '咸阳', lat: 34.3296, lon: 108.7088 },
  // 甘肃
  { name: '兰州', lat: 36.0611, lon: 103.8343 },
  { name: '天水', lat: 34.5809, lon: 105.7249 },
  // 青海
  { name: '西宁', lat: 36.6171, lon: 101.7789 },
  // 宁夏
  { name: '银川', lat: 38.4872, lon: 106.2309 },
  // 新疆
  { name: '乌鲁木齐', lat: 43.8266, lon: 87.6168 },
  { name: '喀什', lat: 39.4677, lon: 75.9938 },
  // 香港/澳门/台湾
  { name: '香港', lat: 22.3193, lon: 114.1694 },
  { name: '澳门', lat: 22.1987, lon: 113.5439 },
  { name: '台北', lat: 25.0330, lon: 121.5654 },
];

export const DEFAULT_CITY = CITY_PRESETS[0];

export interface WeatherInfo {
  temperature: number;
  weathercode: number;
  cityName: string;
  /** 该数据来自超期缓存（> 2 小时），正在后台回源刷新 */
  isStale?: boolean;
}

/** WMO weathercode → 中文描述 + emoji 图标（UI 层可直接渲染） */
export function wmoToText(code: number): { label: string; icon: string } {
  if (code === 0) return { label: '晴', icon: '☀️' };
  if (code === 1) return { label: '大部晴朗', icon: '🌤️' };
  if (code === 2) return { label: '局部多云', icon: '⛅' };
  if (code === 3) return { label: '阴', icon: '☁️' };
  if (code === 45 || code === 48) return { label: '雾', icon: '🌫️' };
  if (code >= 51 && code <= 55) return { label: '毛毛雨', icon: '🌦️' };
  if (code >= 56 && code <= 57) return { label: '冻毛毛雨', icon: '🌧️' };
  if (code >= 61 && code <= 65) return { label: '雨', icon: '🌧️' };
  if (code >= 66 && code <= 67) return { label: '冻雨', icon: '🌧️' };
  if (code >= 71 && code <= 77) return { label: '雪', icon: '❄️' };
  if (code >= 80 && code <= 82) return { label: '阵雨', icon: '🌦️' };
  if (code >= 85 && code <= 86) return { label: '阵雪', icon: '🌨️' };
  if (code >= 95 && code <= 99) return { label: '雷雨', icon: '⛈️' };
  return { label: '未知', icon: '🌡️' };
}

const CACHE_KEY = 'weather.cache';
const CITY_KEY = 'weather.city';
const CACHE_TTL = 2 * 60 * 60 * 1000; // 2 小时

/** 判定经纬度是否指向同一个地点（0.05° ≈ 5km，足够区分列表里的城市） */
const SAME_PLACE_EPS = 0.05;

interface CachePayload {
  lat: number;
  lon: number;
  cityName: string;
  temperature: number;
  weathercode: number;
  fetchedAt: number;
}

/**
 * 进程内缓存镜像：一次页面会话内多次调用 getWeatherSync/refreshWeather
 * 不重复打服务端 /api/kv。clearWeatherCache / 成功回源时同步失效。
 */
let memCache: CachePayload | null = null;
/** 并发去重：多个组件同时 refreshWeather 时共享同一个请求 */
let inflight: Promise<WeatherInfo | null> | null = null;

/**
 * 读取 kv（REST）。键不存在时后端返回 404 —— 属于正常状态（"还没设置过"），
 * 一律返回 null，不向上抛错。
 */
async function kvGet<T>(key: string): Promise<T | null> {
  try {
    const res = await fetch(`/api/kv/${key}`);
    if (!res.ok) return null;
    const row = (await res.json()) as { key: string; value: T | null };
    return row.value ?? null;
  } catch {
    return null;
  }
}

function isCacheShape(c: unknown): c is CachePayload {
  if (c === null || typeof c !== 'object') return false;
  const p = c as Partial<CachePayload>;
  return (
    typeof p.lat === 'number' &&
    typeof p.lon === 'number' &&
    typeof p.cityName === 'string' &&
    typeof p.temperature === 'number' &&
    typeof p.weathercode === 'number' &&
    typeof p.fetchedAt === 'number'
  );
}

/** 读缓存（内存优先，回落 kv），同时把结果写回内存镜像 */
async function readCacheRaw(): Promise<CachePayload | null> {
  if (memCache) return memCache;
  const c = await kvGet<unknown>(CACHE_KEY);
  if (!isCacheShape(c)) return null;
  memCache = c;
  return c;
}

async function writeCache(w: WeatherInfo, lat: number, lon: number): Promise<void> {
  const payload: CachePayload = {
    temperature: w.temperature,
    weathercode: w.weathercode,
    cityName: w.cityName,
    lat,
    lon,
    fetchedAt: Date.now(),
  };
  memCache = payload;
  try {
    await apiFetch(`/api/kv/${CACHE_KEY}`, 'PUT', { value: payload });
  } catch {
    /* 缓存写失败无所谓：内存镜像仍然有效 */
  }
}

/** 丢弃缓存（城市切换时调用：新城市的天气不能沿用旧城市的缓存） */
export async function clearWeatherCache(): Promise<void> {
  memCache = null;
  try {
    // 后端 DELETE 返回 204（无 body），不能用 apiFetch（它会 r.json()）
    await fetch(`/api/kv/${CACHE_KEY}`, { method: 'DELETE' });
  } catch {
    /* 删不掉也不影响本次强制回源 */
  }
}

function toWeatherInfo(c: CachePayload, stale: boolean): WeatherInfo {
  return stale
    ? {
        temperature: c.temperature,
        weathercode: c.weathercode,
        cityName: c.cityName,
        isStale: true,
      }
    : { temperature: c.temperature, weathercode: c.weathercode, cityName: c.cityName };
}

/** 读取用户选定城市（默认北京） */
export async function getSavedCity(): Promise<CityPreset> {
  const saved = await kvGet<{ name?: string }>(CITY_KEY);
  if (saved && typeof saved === 'object') {
    const hit = CITY_PRESETS.find((c) => c.name === saved.name);
    if (hit) return hit;
  }
  return DEFAULT_CITY;
}

export async function saveCity(city: CityPreset): Promise<void> {
  await apiFetch(`/api/kv/${CITY_KEY}`, 'PUT', { value: { name: city.name } });
}

function nearestCityName(lat: number, lon: number): string {
  let best = DEFAULT_CITY;
  let bestD = Infinity;
  for (const c of CITY_PRESETS) {
    const d = Math.abs(c.lat - lat) + Math.abs(c.lon - lon);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return bestD < 0.5 ? best.name : '当前位置';
}

/** 浏览器定位，3 秒超时，失败返回 null */
function geolocate(): Promise<{ lat: number; lon: number } | null> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      return resolve(null);
    }
    const timer = setTimeout(() => resolve(null), 3000);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude });
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
      { timeout: 3000, maximumAge: 10 * 60 * 1000 },
    );
  });
}

interface Target {
  lat: number;
  lon: number;
  cityName: string;
}

/** 定位优先级：浏览器定位 → 用户选定城市（默认北京） */
async function resolveTarget(): Promise<Target> {
  const geo = await geolocate();
  if (geo) {
    return { lat: geo.lat, lon: geo.lon, cityName: nearestCityName(geo.lat, geo.lon) };
  }
  const city = await getSavedCity();
  return { lat: city.lat, lon: city.lon, cityName: city.name };
}

async function requestOpenMeteo(target: Target): Promise<WeatherInfo | null> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${target.lat}&longitude=${target.lon}&current_weather=true`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = (await res.json()) as {
    current_weather?: { temperature?: number; weathercode?: number };
  };
  const cw = data.current_weather;
  if (!cw || typeof cw.temperature !== 'number' || typeof cw.weathercode !== 'number') {
    return null;
  }
  const info: WeatherInfo = {
    temperature: cw.temperature,
    weathercode: cw.weathercode,
    cityName: target.cityName,
  };
  await writeCache(info, target.lat, target.lon);
  return info;
}

/**
 * 同步取缓存（SWR 的 "stale" 那一半）。
 *
 * 不等待定位、也不发外网请求，因此挂载后第一帧就能拿到内容：
 * - 命中未超期缓存 → isStale 不设置
 * - 命中超期缓存（> 2 小时）→ 仍然返回，但标记 isStale=true
 * - 无缓存 → null（此时 UI 显示城市名占位，不会空白）
 */
export async function getWeatherSync(): Promise<WeatherInfo | null> {
  try {
    const c = await readCacheRaw();
    if (!c) return null;
    return toWeatherInfo(c, Date.now() - c.fetchedAt >= CACHE_TTL);
  } catch {
    return null;
  }
}

/**
 * 后台回源（SWR 的 "revalidate" 那一半）。
 *
 * - 默认遵守 2 小时 TTL：同地点且缓存仍在有效期内时直接复用缓存，不打 Open-Meteo。
 * - force=true 时无条件回源（城市切换后调用）。
 * - 并发调用共享同一个 in-flight 请求。
 * - 失败返回 null：调用方保留已渲染的内容（过期值继续显示，不闪空白）。
 */
export async function refreshWeather(options?: { force?: boolean }): Promise<WeatherInfo | null> {
  const force = options?.force === true;
  // 强制回源（城市切换）不复用普通回源的 in-flight：那个请求的目标城市可能已经过期了
  if (!force && inflight) return inflight;

  const task = (async (): Promise<WeatherInfo | null> => {
    try {
      const target = await resolveTarget();
      if (!force) {
        const cached = await readCacheRaw();
        const samePlace =
          cached !== null &&
          Math.abs(cached.lat - target.lat) < SAME_PLACE_EPS &&
          Math.abs(cached.lon - target.lon) < SAME_PLACE_EPS;
        if (samePlace && cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
          return toWeatherInfo(cached, false);
        }
      }
      return await requestOpenMeteo(target);
    } catch {
      return null;
    }
  })();

  inflight = task;
  try {
    return await task;
  } finally {
    if (inflight === task) inflight = null;
  }
}

/**
 * 兼容入口：先给缓存（可能超期），再回源；回源失败时退回缓存值。
 * 新代码请直接用 getWeatherSync + refreshWeather。
 */
export async function fetchWeather(): Promise<WeatherInfo | null> {
  const cached = await getWeatherSync();
  const fresh = await refreshWeather();
  return fresh ?? cached;
}
