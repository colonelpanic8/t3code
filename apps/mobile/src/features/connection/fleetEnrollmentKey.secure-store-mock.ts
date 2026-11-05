/** In-memory `expo-secure-store` for the fleet enrollment key tests. */
const items = new Map<string, string>();

export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 1;
export const getItemAsync = async (key: string) => items.get(key) ?? null;
export const setItemAsync = async (key: string, value: string) => void items.set(key, value);
export const deleteItemAsync = async (key: string) => void items.delete(key);
