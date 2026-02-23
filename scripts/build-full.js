const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

//配置区
const PROJECT_ROOT = path.join(__dirname, '..');
const RELEASE_DIR = path.join(PROJECT_ROOT, 'release');
const INSTALLER_PRJ_DIR = path.join(PROJECT_ROOT, 'MyCoolInstaller');
const EMBEDDED_NAME = 'EmbeddedInstaller.exe';

function log(msg) {
    console.log(`\n\x1b[36m[Build-Full]\x1b[0m ${msg}`);
}

function error(msg) {
    console.error(`\n\x1b[31m[Error]\x1b[0m ${msg}`);
    process.exit(1);
}

try {
    // 1. 构建核心 Electron 应用 (包含 NSIS 打包 + UPX 优化)
    log('🚀 Step 1: 构建核心 Electron 应用...');
    execSync('npm run build', { stdio: 'inherit', cwd: PROJECT_ROOT });

    // 2. 找到生成的 NSIS 安装包 (必须匹配当前版本)
    log('🔍 Step 2: 寻找生成的 NSIS 安装包...');
    if (!fs.existsSync(RELEASE_DIR)) error('Release 目录不存在，构建可能失败');

    // 读取项目版本
    const pkgPath = path.join(PROJECT_ROOT, 'package.json');
    const pkgVersion = require(pkgPath).version;
    const expectedName = `VXdaochu-${pkgVersion}-Setup.exe`;
    const nsisPath = path.join(RELEASE_DIR, expectedName);

    if (!fs.existsSync(nsisPath)) {
        // 尝试模糊搜索作为备选（有时候 electron-builder 不带版本号？）
        error(`未找到目标版本安装包: ${expectedName}\n请检查 package.json 版本号是否与生成产物一致。`);
    }

    const version = pkgVersion;
    log(`✅ 找到安装包: ${expectedName} (v${version})`);

    // 3. 复制到 WPF 工程目录准备嵌入
    log('🚚 Step 3: 注入到安装器工程...');
    const targetPayloadPath = path.join(INSTALLER_PRJ_DIR, EMBEDDED_NAME);
    fs.copyFileSync(nsisPath, targetPayloadPath);

    // 4. 编译 WPF 外壳 (需要系统中装有 .NET SDK)
    log('🔨 Step 4: 编译 WPF 高颜值外壳...');

    // 动态同步版本号：将 package.json 的 version 同步到 CSPROJ
    // .NET 版本号遵循 Major.Minor.Build.Revision (4位)，所以补个 .0
    const netVersion = version.split('.').length === 3 ? `${version}.0` : version;
    const csprojPath = path.join(INSTALLER_PRJ_DIR, 'MyCoolInstaller.csproj');

    let csprojContent = fs.readFileSync(csprojPath, 'utf8');
    csprojContent = csprojContent.replace(/<AssemblyVersion>.*<\/AssemblyVersion>/g, `<AssemblyVersion>${netVersion}</AssemblyVersion>`);
    csprojContent = csprojContent.replace(/<FileVersion>.*<\/FileVersion>/g, `<FileVersion>${netVersion}</FileVersion>`);
    fs.writeFileSync(csprojPath, csprojContent);
    log(`ℹ️  已更新安装器元数据版本为: ${netVersion}`);

    // 指向具体的 csproj，避免多项目时的歧义
    // 不使用 -o 参数，规避 Solution 构建时的路径冲突
    const publishCmd = `dotnet publish "${csprojPath}" -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true`;

    try {
        execSync(publishCmd, { stdio: 'inherit' });
    } catch (e) {
        error('WPF 编译失败。请确保安装了 .NET 8 SDK。');
    }

    // 5. 将最终产物移回 release 目录
    log('🎁 Step 5: 输出最终产物...');

    // 默认发布路径
    const wpfOutput = path.join(INSTALLER_PRJ_DIR, 'bin', 'Release', 'net8.0-windows', 'win-x64', 'publish', 'MyCoolInstaller.exe');
    if (!fs.existsSync(wpfOutput)) error(`WPF 产物未找到: ${wpfOutput}`);

    // 记录原始大小用于日志
    const originalSize = (fs.statSync(nsisPath).size / 1024 / 1024).toFixed(2);

    // A. 备份原版 (改名为 Core-Setup)
    const coreName = `VXdaochu-${version}-Core-Setup.exe`;
    const corePath = path.join(RELEASE_DIR, coreName);
    if (fs.existsSync(corePath)) fs.unlinkSync(corePath); // 覆盖旧备份
    fs.renameSync(nsisPath, corePath);
    log(`ℹ️  原版安装包已重命名备份为: ${coreName}`);

    // B. WPF 外壳上位 (使用标准 Setup 名字)
    const finalName = `VXdaochu-${version}-Setup.exe`;
    const finalPath = path.join(RELEASE_DIR, finalName);

    // 复制前先检查占用
    try {
        if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
        fs.copyFileSync(wpfOutput, finalPath);
    } catch (e) {
        if (e.code === 'EBUSY') error(`目标文件被占用: ${finalPath}\n请关闭文件夹或程序后重试。`);
        throw e;
    }

    // 清理临时文件
    fs.unlinkSync(targetPayloadPath);

    log(`🎉🎉🎉 全流程构建完成！`);
    log(`📂 最终安装包: ${finalPath}`);
    log(`📏 原始大小: ${originalSize} MB`);
    const finalSize = fs.statSync(finalPath).size;
    log(`📏 最终大小: ${(finalSize / 1024 / 1024).toFixed(2)} MB`);

    // 6. 关键步骤：更新 latest.yml 以匹配新的安装包
    // 否则自动更新会因为 SHA512 不匹配而失败
    log('📝 Step 6: 修正 latest.yml 校验信息...');
    const yamlPath = path.join(RELEASE_DIR, 'latest.yml');

    // A. 必须删除 .blockmap 文件！
    // 因为我们的 Setup.exe 已经被替换，原有的 blockmap 是针对旧 EXE 的。
    // 如果不删，Updater 会尝试差分更新，导致校验失败。
    const blockMapName = `${finalName}.blockmap`;
    const blockMapPath = path.join(RELEASE_DIR, blockMapName);
    if (fs.existsSync(blockMapPath)) {
        fs.unlinkSync(blockMapPath);
        log(`🗑️  已删除无效的 BlockMap: ${blockMapName} (禁用差分更新)`);
    }

    if (fs.existsSync(yamlPath)) {
        const crypto = require('crypto');

        // 计算新的 SHA512 (Base64格式)
        const buffer = fs.readFileSync(finalPath);
        const hash = crypto.createHash('sha512').update(buffer).digest('base64');

        let yamlContent = fs.readFileSync(yamlPath, 'utf8');

        // 简单正则替换 (避免引入 yaml 库依赖)
        // 1. 替换顶层 sha512
        yamlContent = yamlContent.replace(/sha512: .+/g, `sha512: ${hash}`);

        // 2. 替换顶层 size
        yamlContent = yamlContent.replace(/size: \d+/g, `size: ${finalSize}`);

        // 3. 确保 files 列表下的信息也更新 (如果有)
        // 这比较复杂，通常 electron-updater 主要看顶层，或者 files 里的第一项
        // 我们假设 electron-builder 生成的标准格式，暴力替换所有匹配的 checksum
        // 但更安全的是只替换顶部的。标准 latest.yml 结构中 files 下也有 sha512。

        // 重新写入
        fs.writeFileSync(yamlPath, yamlContent);
        log(`✅ latest.yml 已更新:\n   SHA512: ${hash.substring(0, 20)}...\n   Size: ${finalSize}`);
    } else {
        log('⚠️ 未找到 latest.yml，跳过元数据更新 (仅本地构建？)');
    }

} catch (err) {
    error(err.message);
}
