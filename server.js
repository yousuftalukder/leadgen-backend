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

// Helper: Safely extracts posts
function extractPosts(items) {
    let posts = [];
    items.forEach(item => {
        if (item.ownerUsername || item.shortCode || item.caption) posts.push(item);
        if (item.topPosts && Array.isArray(item.topPosts)) posts.push(...item.topPosts);
        if (item.latestPosts && Array.isArray(item.latestPosts)) posts.push(...item.latestPosts);
    });
    return posts;
}

// Upgraded Runner: Now logs the TRUE extracted post count
async function runActor(actorId, input, warningsArray, methodName) {
    try {
        console.log(`[Apify] Triggering ${actorId} for ${methodName}...`);
        const run = await apify.actor(actorId).call(input);
        const { items } = await apify.dataset(run.defaultDatasetId).listItems();
        
        const extracted = extractPosts(items || []);
        
        if (warningsArray) warningsArray.push(`X-RAY (${methodName}): Extracted ${extracted.length} real posts.`);
        
        return extracted; // Return the clean posts directly!
    } catch (err) {
        console.error(`[Apify ERROR] ${actorId}:`, err.message);
        if (warningsArray) warningsArray.push(`🚨 Error (${methodName}): ${err.message}`);
        return [];
    }
}

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

        // =========================================================================
        // METHOD 1: Locations (Using API Scraper for true location text search)
        // =========================================================================
        if (selected_methods.includes('method_1') && location) {
            const cities = location.split(',').map(c => c.trim()).filter(Boolean);
            const lowerKeywords = method1_keywords.map(k => k.toLowerCase().trim());
            
            for (const city of cities) {
                // We use the API scraper here because it naturally searches locations by text
                const posts = await runActor('apify/instagram-api-scraper', { query: city, limit: 60 }, warnings, `Method 1 (${city})`);
                
                posts.forEach(i => {
                    const handle = i.user?.username || i.ownerUsername || i.username;
                    const caption = (i.caption || i.text || '').toLowerCase();
                    
                    if (handle && (lowerKeywords.length === 0 || lowerKeywords.some(kw => caption.includes(kw)))) {
                        rawDiscoveredPosts.push({
                            username: handle, post_views: i.videoViewCount || i.playCount || i.viewCount || 0,
                            post_likes: i.likesCount || 0, post_comments: i.commentsCount || 0,
                            post_timestamp: i.timestamp || i.takenAt || new Date().toISOString(), post_url: i.url || `https://instagram.com/p/${i.shortCode}`
                        });
                    }
                });
            }
        }

        // =========================================================================
        // METHOD 3: Hashtag Feed (Direct URLs - Working Perfectly!)
        // =========================================================================
        if (selected_methods.includes('method_3') && hashtags.length) {
            const cleanHashtags = hashtags.map(h => h.replace('#', '').trim()).filter(Boolean);
            const directUrls = cleanHashtags.map(tag => `https://www.instagram.com/explore/tags/${tag}/`);
            const dynamicLimit = cleanHashtags.length * 40; 
            
            const posts = await runActor('apify/instagram-scraper', { directUrls: directUrls, resultsLimit: dynamicLimit }, warnings, 'Method 3 (Hashtags)');
            
            posts.forEach(i => {
                const handle = i.ownerUsername || i.username || i.owner?.username;
                if (handle) {
                    rawDiscoveredPosts.push({
                        username: handle, post_views: i.videoViewCount || i.playCount || i.viewCount || 0,
                        post_likes: i.likesCount || 0, post_comments: i.commentsCount || 0,
                        post_timestamp: i.timestamp || i.takenAt || new Date().toISOString(), post_url: i.url || `https://instagram.com/p/${i.shortCode}`
                    });
                }
            });
        }

        // =========================================================================
        // METHOD 3.1: Global Phrase (Using API Scraper for Text Phrases)
        // =========================================================================
        if (selected_methods.includes('method_3_1') && method3_1_keywords.length) {
            for (const kw of method3_1_keywords) {
                // API scraper handles long phrases best
                const posts = await runActor('apify/instagram-api-scraper', { query: kw, limit: 30 }, warnings, `Method 3.1 (${kw})`);
                
                posts.forEach(i => {
                    const handle = i.user?.username || i.ownerUsername || i.username;
                    if (handle) {
                        rawDiscoveredPosts.push({
                            username: handle, post_views: i.videoViewCount || i.playCount || i.viewCount || 0,
                            post_likes: i.likesCount || 0, post_comments: i.commentsCount || 0,
                            post_timestamp: i.timestamp || i.takenAt || new Date().toISOString(), post_url: i.url || `https://instagram.com/p/${i.shortCode}`
                        });
                    }
                });
            }
        }

        // Deduplicate the massive list so you only get unique humans
        const uniquePostMap = new Map();
        rawDiscoveredPosts.forEach(post => {
            const u = post.username.toLowerCase().trim().replace('@', '');
            if (!uniquePostMap.has(u) || post.post_views > uniquePostMap.get(u).post_views) {
                uniquePostMap.set(u, { ...post, username: u });
            }
        });

        const uniquePosts = Array.from(uniquePostMap.values());
        let newLeadsSaved = 0;

        // Save Stage 1 Base Data to Supabase
        for (const post of uniquePosts) {
            const { data: savedLead, error: leadErr } = await supabase.from('leads').upsert({
                username: post.username,
                profile_url: `https://instagram.com/${post.username}`,
                is_enriched: false 
            }, { onConflict: 'username' }).select().single();

            if (!leadErr && savedLead) {
                const { error: linkErr } = await supabase.from('campaign_leads').insert([{
                    campaign_id: activeCampaignId,
                    lead_id: savedLead.id,
                    user_id: user.id,
                    top_post_url: post.post_url,
                    top_post_views: post.post_views,
                    post_likes: post.post_likes,
                    post_comments: post.post_comments,
                    post_timestamp: new Date(post.post_timestamp).toISOString()
                }]);
                if (!linkErr) newLeadsSaved++;
            }
        }

        await supabase.from('campaigns').update({ total_leads_found: newLeadsSaved }).eq('id', activeCampaignId);
        
        res.status(200).json({ success: true, newUniqueLeads: newLeadsSaved, warnings });

    } catch (err) {
        res.status(500).json({ error: err.message, warnings });
    }
});

// ... [Keep your existing /api/enrich-campaign and /api/client-history routes exactly the same below this]
