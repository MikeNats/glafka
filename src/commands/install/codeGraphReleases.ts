import { CBM_NAME, CBM_VERSION } from '../../memory/cbm.js';

// Not glafka's: a free public project under MIT, by DeusData.
export const CBM_ABOUT = `${CBM_NAME} ${CBM_VERSION}: free, MIT, by DeusData — https://github.com/DeusData/${CBM_NAME}`;
export const RELEASES = `https://github.com/DeusData/${CBM_NAME}/releases/download/v${CBM_VERSION}`;

// One pinned file per platform, with the SHA-256 GitHub publishes for it. A file that does not
// match is refused: it is not the one glafka was tested against.
export const RELEASE_FILES: Record<string, { file: string; sha256: string }> = {
  'darwin-arm64': {
    file: `${CBM_NAME}-darwin-arm64.tar.gz`,
    sha256: '1be41a9dd6902e3633eb0b280189117dc3db3be623bdd3dd4c6ea74372b5a50b',
  },
  'darwin-x64': {
    file: `${CBM_NAME}-darwin-amd64.tar.gz`,
    sha256: 'af3beeeaca53204faf350402ddacee04780a53d0fa510dc31941fb5c2202ff35',
  },
  'linux-arm64': {
    file: `${CBM_NAME}-linux-arm64-portable.tar.gz`,
    sha256: '8e603f32c9c84b5dc5a6b4a0d23516817d5de199e30f8dcc9bdb128c39386cd8',
  },
  'linux-x64': {
    file: `${CBM_NAME}-linux-amd64-portable.tar.gz`,
    sha256: '7024e585132760f383e3e25237e2b2ac6f5185f7e466f8dc66a085bb25f8d0be',
  },
  'win32-arm64': {
    file: `${CBM_NAME}-windows-arm64.zip`,
    sha256: '04098a1a3c06edccb4e5c96b552569ecacd2f48fe073dee8dbcec133bd2fe18f',
  },
  'win32-x64': {
    file: `${CBM_NAME}-windows-amd64.zip`,
    sha256: '0675af7894d293cb755e85f1f471b4b8dd401988f03ad183b3d3d74788517165',
  },
};
