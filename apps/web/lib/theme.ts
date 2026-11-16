/** Shared by the server layout and the client switch (never import constants from a 'use client' file into a server component). */
export type ThemeChoice = 'light' | 'dark' | 'system';
export const THEME_COOKIE = 'tv_theme';
