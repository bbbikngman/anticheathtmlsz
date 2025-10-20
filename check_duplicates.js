const fs = require('fs');
const path = require('path');

// 读取 cache_index.json 文件
const cacheIndexPath = path.join(__dirname, 'prerecorded_audio', 'cache_index.json');
const cacheData = JSON.parse(fs.readFileSync(cacheIndexPath, 'utf8'));

// 获取所有 keys
const keys = Object.keys(cacheData);

console.log('=== 重复校验结果 ===');
console.log('总 key 数:', keys.length);
console.log('唯一 key 数:', new Set(keys).size);

// 检查是否有重复
if (keys.length === new Set(keys).size) {
    console.log('✅ 没有重复的 key');
} else {
    console.log('❌ 发现重复的 key');
    
    // 找出重复的 key
    const keyCount = {};
    const duplicates = [];
    
    keys.forEach(key => {
        keyCount[key] = (keyCount[key] || 0) + 1;
        if (keyCount[key] === 2) {
            duplicates.push(key);
        }
    });
    
    console.log('重复的 key 列表:');
    duplicates.forEach(key => {
        console.log(`  - ${key} (出现 ${keyCount[key]} 次)`);
    });
}

// 额外检查：验证 key 格式是否正确（应该是 32 位 MD5 哈希）
console.log('\n=== Key 格式验证 ===');
const md5Pattern = /^[a-f0-9]{32}$/;
const invalidKeys = keys.filter(key => !md5Pattern.test(key));

if (invalidKeys.length === 0) {
    console.log('✅ 所有 key 都是有效的 MD5 格式');
} else {
    console.log('❌ 发现格式不正确的 key:');
    invalidKeys.forEach(key => {
        console.log(`  - ${key}`);
    });
}

// 检查 audio_file 字段是否与 key 匹配
console.log('\n=== Audio File 一致性检查 ===');
const inconsistentFiles = [];

Object.entries(cacheData).forEach(([key, data]) => {
    const expectedFileName = `${key}.mp3`;
    if (data.audio_file !== expectedFileName) {
        inconsistentFiles.push({
            key,
            expected: expectedFileName,
            actual: data.audio_file
        });
    }
});

if (inconsistentFiles.length === 0) {
    console.log('✅ 所有 audio_file 字段都与 key 匹配');
} else {
    console.log('❌ 发现不匹配的 audio_file:');
    inconsistentFiles.forEach(item => {
        console.log(`  - Key: ${item.key}`);
        console.log(`    期望: ${item.expected}`);
        console.log(`    实际: ${item.actual}`);
    });
}

console.log('\n=== 检查完成 ===');