import { useSyncExternalStore } from 'react';
import Taro from '@tarojs/taro';
import type { UserVM } from '@badminton/shared';
import { STORAGE_KEYS } from '../config';

let current: UserVM | null = null;
const listeners = new Set<() => void>();

export function setUser(u: UserVM | null): void {
  current = u;
  if (u) Taro.setStorageSync(STORAGE_KEYS.user, u);
  listeners.forEach((l) => l());
}

export function getUser(): UserVM | null {
  if (!current) {
    const cached = Taro.getStorageSync(STORAGE_KEYS.user);
    if (cached) current = cached as UserVM;
  }
  return current;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** React hook：订阅当前登录用户 */
export function useUser(): UserVM | null {
  return useSyncExternalStore(subscribe, getUser, getUser);
}
