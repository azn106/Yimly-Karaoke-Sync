import * as ResEdit from 'resedit';
import fs from 'fs';

const exe = ResEdit.NtExecutable.createEmpty(false); // 64-bit Windows PE
const res = ResEdit.NtExecutableResource.from(exe);

// 1. Add Version Info
const vi = ResEdit.Resource.VersionInfo.createEmpty();
vi.setFileVersion(1, 2, 0, 0, 1033);
vi.setProductVersion(1, 2, 0, 0, 1033);
vi.setStringValues(
  { lang: 1033, codepage: 1200 },
  {
    FileDescription: 'Yimly Sync Monitor Launcher',
    ProductName: 'Yimly Sync Monitor',
    CompanyName: 'Yimly',
    FileVersion: '1.2.0.0',
    ProductVersion: '1.2.0.0',
    OriginalFilename: 'Yimly Sync Monitor.exe',
    InternalName: 'Yimly Sync Monitor',
    LegalCopyright: 'Copyright (C) Yimly',
  }
);
vi.outputToResourceEntries(res.entries);

// 2. Add Yimly.ico Icon Group
const icoBuf = fs.readFileSync('Yimly.ico');
const iconFile = ResEdit.Data.IconFile.from(icoBuf);
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
  res.entries,
  1,
  1033,
  iconFile.icons.map((item) => item.data)
);

// 3. Output resources to PE
res.outputResource(exe);

// Generate final Windows EXE binary
const newBinary = exe.generate();
fs.writeFileSync('Yimly Sync Monitor.exe', Buffer.from(newBinary));
console.log('Successfully generated "Yimly Sync Monitor.exe" with embedded Yimly.ico (Size: ' + newBinary.byteLength + ' bytes)');
