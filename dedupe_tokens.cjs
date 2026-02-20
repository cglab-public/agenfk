const fs = require('fs');
const dbPath = '/home/danielp/agefk/agenfk-framework/.agenfk/db.json';

function deduplicate() {
    const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    
    db.items.forEach(item => {
        if (item.tokenUsage && item.tokenUsage.length > 1) {
            // Very simple deduplication: if multiple identical entries exist, keep only one
            const unique = [];
            const seen = new Set();
            item.tokenUsage.forEach(usage => {
                const key = `${usage.input}-${usage.output}-${usage.model}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    unique.push(usage);
                }
            });
            item.tokenUsage = unique;
        }
    });

    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
    console.log("Deduplicated token usage.");
}

deduplicate();
