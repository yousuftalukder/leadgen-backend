const express = require('express');
const cors = require('cors');
const { ApifyClient } = require('apify-client');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const apify = new ApifyClient({ token: process.env.APIFY_API_TOKEN });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Helper: Extracts post objects from flat arrays or nested wrappers
function extractPosts(items) {
    let posts = [];
    (items || []).forEach(item => {
        if (item.ownerUsername || item.shortCode || item.caption) posts.push(item);
        if (item.topPosts && Array.isArray(item.topPosts)) posts.push(...item.topPosts);
        if (item.latestPosts && Array.isArray(item.latestPosts)) posts.push(...item.latestPosts);
    });
    return posts;
}

// Actor Execution Wrapper with Error Handling and Diagnostics
async function runActor(actorId, input, warningsArray, methodName) {
    try {
        console.log(`[Apify] Triggering ${actorId} for ${methodName}...`);
        const run = await apify.actor(actorId).call(input);
        const { items } = await apify.dataset(run.defaultDatasetId).listItems();
        
        const extracted = extractPosts(items || []);
        if (warningsArray) warningsArray.push(`X-RAY (${methodName}): Extracted ${extracted.length} real posts.`);
        
        return extracted; 
    } catch (err) {
        console.error(`[Apify ERROR] ${actorId}:`, err.message);
        if (warningsArray) warningsArray.push(`🚨 Error (${methodName}): ${err.message}`);
        return [];
    }
}

// =========================================================================
// ROUTE 1: STAGE 1 DISCOVERY (POST INDEX ONLY)
// =========================================================================
app.post('/api/run-campaign', async (req, res) => {
    let warnings = []; 
    try {
        const authHeader = req.headers.authorization;
        const token = authHeader?.replace('Bearer ', '');
        const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
        if (authErr || !user) return res.status(401).json({ error: 'Unauthorized' });

        const { campaignName, location, method1_keywords = [], hashtags = [], method3_1_keywords = [], selected_methods = [] } = req.body;

        const { data: newCmp, error: cmpErr } = await supabase.from('campaigns').insert([{
            user_id: user.id,
            name: campaignName || 'Discovery Campaign',
            location,
            keywords: [...method1_keywords, ...method3_1_keywords],
            selected_methods
        }]).select().single();
        
        if (cmpErr) throw cmpErr;
        const activeCampaignId = newCmp.id;

        let rawDiscoveredPosts = [];

        // METHOD 1: Location Feed
        if (selected_methods.includes('method_1') && location) {
            const locInputs = location.split(',').map(c => c.trim()).filter(Boolean);
            const directUrls = locInputs.filter(loc => loc.includes('instagram.com/explore/locations'));
            
            if (directUrls.length > 0) {
                const lowerKeywords = method1_keywords.map(k => k.toLowerCase().trim());
                const posts = await runActor('apify/instagram-scraper', { directUrls: directUrls, resultsLimit: 1000 }, warnings, `Method 1 (Locations)`);
                
                posts.forEach(i => {
                    const handle = i.ownerUsername || i.owner?.username || i.username || i.user?.username;
                    const caption = (i.caption || i.text || '').toLowerCase();
                    if (handle && (lowerKeywords.length === 0 || lowerKeywords.some(kw => caption.includes(kw)))) {
                        rawDiscoveredPosts.push({
                            username: handle, 
                            post_views: i.videoViewCount || i.playCount || i.viewCount || 0,
                            post_likes: i.likesCount || 0, 
                            post_comments: i.commentsCount || 0,
                            post_timestamp: i.timestamp || i.takenAt || new Date().toISOString(), 
                            post_url: i.url || `https://instagram.com/p/${i.shortCode}`
                        });
                    }
                });
            } else {
                warnings.push("⚠️ METHOD 1 SKIPPED: Location requires a full URL (e.g., https://instagram.com/explore/locations/...).");
            }
        }

        // METHOD 3: Hashtag Feed
        if (selected_methods.includes('method_3') && hashtags.length) {
            const cleanHashtags = hashtags.map(h => h.replace('#', '').trim()).filter(Boolean);
            const directUrls = cleanHashtags.map(tag => `https://www.instagram.com/explore/tags/${tag}/`);
            
            const posts = await runActor('apify/instagram-scraper', { directUrls: directUrls, resultsLimit: 1000 }, warnings, 'Method 3 (Hashtags)');
            
            posts.forEach(i => {
                const handle = i.ownerUsername || i.owner?.username || i.username || i.user?.username;
                if (handle) {
                    rawDiscoveredPosts.push({
                        username: handle, 
                        post_views: i.videoViewCount || i.playCount || i.viewCount || 0,
                        post_likes: i.likesCount || 0, 
                        post_comments: i.commentsCount || 0,
                        post_timestamp: i.timestamp || i.takenAt || new Date().toISOString(), 
                        post_url: i.url || `https://instagram.com/p/${i.shortCode}`
                    });
                }
            });
        }

        // METHOD 3.1: Global Phrase
        if (selected_methods.includes('method_3_1') && method3_1_keywords.length) {
            for (const kw of method3_1_keywords) {
                const posts = await runActor('apify/instagram-scraper', { search: kw, resultsLimit: 1000 }, warnings, `Method 3.1 (${kw})`);
                
                posts.forEach(i => {
                    const handle = i.ownerUsername || i.owner?.username || i.username || i.user?.username;
                    if (handle) {
                        rawDiscoveredPosts.push({
                            username: handle, 
                            post_views: i.videoViewCount || i.playCount || i.viewCount || 0,
                            post_likes: i.likesCount || 0, 
                            post_comments: i.commentsCount || 0,
                            post_timestamp: i.timestamp || i.takenAt || new Date().toISOString(), 
                            post_url: i.url || `https://instagram.com/p/${i.shortCode}`
                        });
                    }
                });
            }
        }

        // Local Deduplication
        const uniquePostMap = new Map();
        rawDiscoveredPosts.forEach(post => {
            const u = post.username.toLowerCase().trim().replace('@', '');
            if (!uniquePostMap.has(u) || post.post_views > uniquePostMap.get(u).post_views) {
                uniquePostMap.set(u, { ...post, username: u });
            }
        });

        const uniquePosts = Array.from(uniquePostMap.values());
        let newLeadsSaved = 0;

        // Safe Database Insertion Loop
        for (const post of uniquePosts) {
            let savedLeadId = null;

            // Check if lead already exists using maybeSingle()
            const { data: existingLead } = await supabase
                .from('leads')
                .select('id')
                .eq('username', post.username)
                .maybeSingle(); 
            
            if (existingLead) {
                savedLeadId = existingLead.id;
            } else {
                const { data: newLead, error: insertErr } = await supabase
                    .from('leads')
                    .insert([{
                        username: post.username,
                        profile_url: `https://instagram.com/${post.username}`,
                        is_enriched: false
                    }])
                    .select('id')
                    .maybeSingle();

                if (insertErr) {
                    console.error(`[DB Error] Lead Insert Failed for @${post.username}:`, insertErr.message);
                    warnings.push(`DB Alert: Failed to save lead @${post.username}`);
                    continue; 
                }
                savedLeadId = newLead?.id;
            }

            if (savedLeadId) {
                const { error: linkErr } = await supabase.from('campaign_leads').insert([{
                    campaign_id: activeCampaignId,
                    lead_id: savedLeadId,
                    user_id: user.id,
                    top_post_url: post.post_url,
                    top_post_views: post.post_views || 0,
                    post_likes: post.post_likes || 0,
                    post_comments: post.post_comments || 0,
                    post_timestamp: new Date(post.post_timestamp).toISOString()
                }]);
                
                if (linkErr) {
                    console.error(`[DB Error] Link Failed for @${post.username}:`, linkErr.message);
                    warnings.push(`DB Alert: Link failed for @${post.username}`);
                } else {
                    newLeadsSaved++;
                }
            }
        }

        await supabase.from('campaigns').update({ total_leads_found: newLeadsSaved }).eq('id', activeCampaignId);
        
        res.status(200).json({ success: true, newUniqueLeads: newLeadsSaved, warnings });

    } catch (err) {
        res.status(500).json({ error: err.message, warnings });
    }
});

// =========================================================================
// ROUTE 2: STAGE 2 ENRICHMENT (METHOD 2)
// =========================================================================
app.post('/api/enrich-campaign', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        const token = authHeader?.replace('Bearer ', '');
        const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
        if (authErr || !user) return res.status(401).json({ error: 'Unauthorized' });

        const { campaignId } = req.body;
        if (!campaignId) return res.status(400).json({ error: 'Campaign ID required' });

        const { data: linkData, error: linkErr } = await supabase.from('campaign_leads')
            .select('leads(id, username, is_enriched)')
            .eq('campaign_id', campaignId);
            
        if (linkErr) throw linkErr;

        const handlesToEnrich = linkData
            .map(d => d.leads)
            .filter(l => l && l.is_enriched !== true)
            .map(l => l.username);

        if (handlesToEnrich.length === 0) {
            return res.status(200).json({ success: true, message: 'All leads in this campaign are already enriched!', enrichedCount: 0 });
        }

        console.log(`[Stage 2] Running Method 2 on ${handlesToEnrich.length} profiles...`);
        const run = await apify.actor('apify/instagram-profile-scraper').call({ usernames: handlesToEnrich });
        const { items: enrichedProfiles } = await apify.dataset(run.defaultDatasetId).listItems();

        let updatedCount = 0;
        for (const p of (enrichedProfiles || [])) {
            const username = (p.username || p.ownerUsername || '').toLowerCase();
            if (!username) continue;

            const { error: updateErr } = await supabase.from('leads').update({
                full_name: p.fullName || null,
                email: p.biographyEmail || p.email || p.inputEmail || null,
                phone: p.businessPhoneNumber || p.phone || null,
                followers_count: p.followersCount || 0,
                is_enriched: true
            }).eq('username', username);

            if (!updateErr) updatedCount++;
        }

        res.status(200).json({ success: true, enrichedCount: updatedCount });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =========================================================================
// ROUTE 3: MASTER HISTORY FETCH
// =========================================================================
app.get('/api/client-history', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        const token = authHeader?.replace('Bearer ', '');
        const { data: { user } } = await supabase.auth.getUser(token);
        
        const { data: campaigns } = await supabase.from('campaigns')
            .select('*, campaign_leads(top_post_views, post_likes, post_comments, post_timestamp, leads(*))')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false });

        res.status(200).json({ campaigns });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Engine active on port ${PORT}`));
