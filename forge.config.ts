import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { WebpackPlugin } from '@electron-forge/plugin-webpack';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { PublisherGithub } from '@electron-forge/publisher-github';

import { mainConfig } from './webpack.main.config';
import { rendererConfig } from './webpack.renderer.config';
import pkg from './package.json';

const APP_HOMEPAGE = 'https://github.com/aidmet/ManageMe';
const DEB_MAINTAINER = `${pkg.author.name} <${pkg.author.email}>`;

const config: ForgeConfig = {
    publishers: [
        new PublisherGithub({
            repository: {
                owner: 'aidmet',
                name: 'ManageMe',
            },
            generateReleaseNotes: true,
        }),
    ],
    packagerConfig: {
        asar: true,
        name: pkg.productName,
        executableName: pkg.name,
        icon: './assets/icons/manage_me_logo.ico',
        appCopyright: `Copyright © ${new Date().getFullYear()} ${pkg.author.name}`,
        appCategoryType: 'public.app-category.business',
        win32metadata: {
            CompanyName: pkg.author.name,
            FileDescription: pkg.description,
            ProductName: pkg.productName,
            InternalName: pkg.productName,
            OriginalFilename: `${pkg.productName}.exe`,
        },
    },
    rebuildConfig: {},
    makers: [
        new MakerSquirrel({
            setupExe: `${pkg.productName}Setup.exe`,
            authors: pkg.author.name,
            description: pkg.description,
            setupIcon: './assets/icons/manage_me_logo.ico',
            loadingGif: './assets/installer/manage_me_loading.gif',
        }),
        new MakerZIP({}, ['darwin']),
        new MakerRpm({
            options: {
                icon: './assets/icons/manage_me_png.png',
                homepage: APP_HOMEPAGE,
                license: pkg.license,
                description: pkg.description,
                productName: pkg.productName,
            },
        }),
        new MakerDeb({
            options: {
                icon: './assets/icons/manage_me_png.png',
                maintainer: DEB_MAINTAINER,
                homepage: APP_HOMEPAGE,
                name: pkg.name,
                productName: pkg.productName,
                genericName: pkg.productName,
                description: pkg.description,
                productDescription: pkg.description,
                categories: ['Office'],
                section: 'utils',
            },
        }),
    ],
    plugins: [
        new AutoUnpackNativesPlugin({}),
        new WebpackPlugin({
            mainConfig,
            // Webpack dev uses eval (e.g. eval-source-map, runtime chunks). style-loader also runs
            // as script. Keep script-src 'unsafe-eval' or the dev server will block the bundle.
            devContentSecurityPolicy:
                "default-src 'self' 'unsafe-inline' data:; " +
                "script-src 'self' 'unsafe-eval' 'unsafe-inline' data:; " +
                "connect-src 'self' https://*.googleapis.com https://*.firebaseio.com wss://*.firebaseio.com;",
            renderer: {
                config: rendererConfig,
                entryPoints: [
                    {
                        html: './src/index.html',
                        js: './src/renderer.ts',
                        name: 'main_window',
                        preload: {
                            js: './src/preload.ts',
                        },
                    },
                ],
            },
        }),
        // Fuses are used to enable/disable various Electron functionality
        // at package time, before code signing the application
        new FusesPlugin({
            version: FuseVersion.V1,
            [FuseV1Options.RunAsNode]: false,
            [FuseV1Options.EnableCookieEncryption]: true,
            [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
            [FuseV1Options.EnableNodeCliInspectArguments]: false,
            [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
            [FuseV1Options.OnlyLoadAppFromAsar]: true,
        }),
    ],
};

export default config;
