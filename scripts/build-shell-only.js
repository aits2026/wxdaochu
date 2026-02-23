const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

//配置区
const PROJECT_ROOT = path.join(__dirname, '..');
const RELEASE_DIR = path.join(PROJECT_ROOT, 'release');
const INSTALLER_PRJ_DIR = path.join(PROJECT_ROOT, 'MyCoolInstaller');
const EMBEDDED_NAME = 'EmbeddedInstaller.exe';

function log(msg) { console.log(`\n\x1b[36m[Build-Shell]\x1b[0m ${msg}`); }
function error(msg) { console.error(`\n\x1b[31m[Error]\x1b[0m ${msg}`); process.exit(1); }

try {
    // 0. 读取当前项目版本
    const pkg = require(path.join(PROJECT_ROOT, 'package.json'));
    const currentVersion = pkg.version;
    log(`ℹ️ 当前项目版本: v${currentVersion}`);

    // 1. 找到对应的 NSIS 安装包
    log('🔍 Step 1: 寻找对应的 NSIS 安装包...');
    if (!fs.existsSync(RELEASE_DIR)) error('Release 目录不存在');

    // 精准匹配当前版本的安装包
    const targetInstallerName = `VXdaochu-${currentVersion}-Setup.exe`;
    const nsisPath = path.join(RELEASE_DIR, targetInstallerName);

    if (!fs.existsSync(nsisPath)) {
        error(`未找到对应版本的安装包: ${targetInstallerName}\n请先运行 npm run build 生成该版本的 Electron 安装包。`);
    }

    log(`✅ 找到安装包: ${targetInstallerName}`);

    // 不需要正则匹配了，版本就是 currentVersion
    const version = currentVersion;

    // 2. 复制到 WPF 工程目录准备嵌入
    log('🚚 Step 2: 注入到安装器工程...');
    const targetPayloadPath = path.join(INSTALLER_PRJ_DIR, EMBEDDED_NAME);
    fs.copyFileSync(nsisPath, targetPayloadPath);

    // 3. 编译 WPF 外壳
    log('🔨 Step 3: 快速编译 WPF 外壳...');
    const csprojPath = path.join(INSTALLER_PRJ_DIR, 'MyCoolInstaller.csproj');
    // 使用 PublishSingleFile 确保成单文件
    const publishCmd = `dotnet publish "${csprojPath}" -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true`;

    try {
        execSync(publishCmd, { stdio: 'inherit' });
    } catch (e) {
        error('WPF 编译失败');
    }

    // 4. 将最终产物移回 release 目录
    log('🎁 Step 4: 输出最终产物...');
    const wpfOutput = path.join(INSTALLER_PRJ_DIR, 'bin', 'Release', 'net8.0-windows', 'win-x64', 'publish', 'MyCoolInstaller.exe');
    if (!fs.existsSync(wpfOutput)) error(`WPF 产物未找到: ${wpfOutput}`);

    // 使用 Shell-Setup 后缀区分全量构建
    const finalName = `VXdaochu-${version}-Shell-Setup.exe`;
    const finalPath = path.join(RELEASE_DIR, finalName);

    try {
        if (fs.existsSync(finalPath)) {
            fs.unlinkSync(finalPath); // 尝试先删除旧文件
        }
        fs.copyFileSync(wpfOutput, finalPath);
    } catch (e) {
        if (e.code === 'EBUSY' || e.code === 'EPERM') {
            error(`目标文件被占用: ${finalPath}\n请关闭正在运行的安装程序或文件夹，然后重试。`);
        } else {
            throw e;
        }
    }

    // 清理临时文件
    fs.unlinkSync(targetPayloadPath);

    log(`🎉🎉🎉 外壳构建完成！`);
    log(`📂 最终安装包: ${finalPath}`);

} catch (err) {
    error(err.message);
}
