/**
 * 看板欢迎区天气（Open-Meteo 免费 API，无需 key）
 * ---------------------------------------------------------------
 * - GET https://api.open-meteo.com/v1/forecast?latitude=&longitude=&current_weather=true
 * - 定位优先级：navigator.geolocation（3s 超时）→ kv 'weather.city'（默认北京）
 * - 结果缓存 30 分钟（kv 'weather.cache'），任何失败返回 null（UI 静默隐藏）
 */

import { apiFetch } from '@/hooks/useApi';

export interface CityPreset {
  name: string;
  lat: number;
  lon: number;
}

export const CITY_PRESETS: CityPreset[] = [
  { name: '北京', lat: 39.9042, lon: 116.4074 },
  { name: '上海', lat: 31.2304, lon: 121.4737 },
  { name: '广州', lat: 23.1291, lon: 113.2644 },
  { name: '深圳', lat: 22.5431, lon: 114.0579 },
  { name: '杭州', lat: 30.2741, lon: 120.1551 },
  { name: '成都', lat: 30.5728, lon: 104.0668 },
];

export const DEFAULT_CITY = CITY_PRESETS[0];

export interface WeatherInfo {
  temperature: number;
  weathercode: number;
  cityName: string;
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
const CACHE_TTL = 30 * 60 * 1000; // 30 分钟

interface CachePayload {
  lat: number;
  lon: number;
  cityName: string;
  temperature: number;
  weathercode: number;
  fetchedAt: number;
}

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

async function readCache(lat: number, lon: number): Promise<WeatherInfo | null> {
  const c = await kvGet<CachePayload>(CACHE_KEY);
  if (!c || typeof c !== 'object') return null;
  const fresh = Date.now() - c.fetchedAt < CACHE_TTL;
  const near = Math.abs(c.lat - lat) < 0.05 && Math.abs(c.lon - lon) < 0.05;
  if (!fresh || !near) return null;
  return { temperature: c.temperature, weathercode: c.weathercode, cityName: c.cityName };
}

async function writeCache(w: WeatherInfo, lat: number, lon: number): Promise<void> {
  try {
    const value = { ...w, lat, lon, fetchedAt: Date.now() } satisfies CachePayload;
    await apiFetch(`/api/kv/${CACHE_KEY}`, 'PUT', { value });
  } catch {
    /* 缓存写失败无所谓 */
  }
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
    if (!('geolocation' in navigator)) return resolve(null);
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

/**
 * 获取天气。useGeo=true 时先尝试浏览器定位，否则用选定城市。
 * 任何失败（离线/跨域/超时）返回 null，由 UI 静默隐藏。
 */
export async function fetchWeather(): Promise<WeatherInfo | null> {
  try {
    let lat: number;
    let lon: number;
    let cityName: string;

    const geo = await geolocate();
    if (geo) {
      lat = geo.lat;
      lon = geo.lon;
      cityName = nearestCityName(lat, lon);
    } else {
      const city = await getSavedCity();
      lat = city.lat;
      lon = city.lon;
      cityName = city.name;
    }

    const cached = await readCache(lat, lon);
    if (cached) return { ...cached, cityName };

    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      current_weather?: { temperature?: number; weathercode?: number };
    };
    const cw = data.current_weather;
    if (!cw || typeof cw.temperature !== 'number' || typeof cw.weathercode !== 'number') {
      return null;
    }
    const info: WeatherInfo = { temperature: cw.temperature, weathercode: cw.weathercode, cityName };
    await writeCache(info, lat, lon);
    return info;
  } catch {
    return null;
  }
}
