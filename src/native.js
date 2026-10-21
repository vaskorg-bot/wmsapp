// Bridges Capacitor plugins to the plain-script app as window.Native
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { App } from '@capacitor/app';

window.Native = {
  isNative: Capacitor.isNativePlatform(),
  platform: Capacitor.getPlatform(),
  Filesystem, Directory, Encoding, Share, App
};
