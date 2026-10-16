import { downloadCodeGraph } from './codeGraphDownload.js';

// Started by install in the background, with the home folder to download into. Not a command.
downloadCodeGraph(process.argv[2]!);
