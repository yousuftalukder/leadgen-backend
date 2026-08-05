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

// Upgraded Runner: Catches Apify errors and returns them cleanly
async function runActor(actorId, input, warningsArray) {
    try {
        console.log(`[Apify] Triggering ${actorId} with input:`, JSON.stringify(input));
        const run = await apify.actor(actorId).call(input);
        const { items } = await apify.dataset(run.defaultDatasetId).listItems();
        console.log(`[Apify] ${actorId} returned ${items ? items.length : 0} items.`);
        return items || [];
    } catch (err) {
        console.error(`[Apify CRITICAL ERROR] ${actorId}:`, err.message);
        if (warningsArray) warningsArray.push(`Apify Error (${actorId}): ${err.message}`);
        return [];
    }
}

// Safety Net: Extracts posts whether Apify returns a flat feed or a nested object
function extractPosts(items) {
    let posts = [];
    items.forEach(item => {
        if (item.ownerUsername || item.shortCode || item.caption) posts.push(item);
        if (item.topPosts && Array.isArray(item.topPosts)) posts.push(...item.topPosts);
        if (item.latestPosts && Array.isArray(item.latestPosts)) posts.push(...item.latestPosts);
    });
    return posts;
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
        
        // Setup 7-Day Cutoff Logic
        const sevenDaysAgo = new Date(Date.now() - (7 * 24 * 60 * 60 * 1000));

        // METHOD 1: Locations (Limit bumped to 100 to catch more food posts under selfies)
        if (selected_methods.includes('method_1') && location) {
            const cities = location.split(',').map(c => c.trim()).filter(Boolean);
            const lowerKeywords = method1_keywords.map(k => k.toLowerCase().trim());
            
            for (const city of cities) {
                const items = await runActor('apify/instagram-scraper', { search: `${city} city`, searchType: 'place', resultsLimit: 100 }, warnings);
                const posts = extractPosts(items);
                
                posts.forEach(i => {
                    const postDate = new Date(i.timestamp || i.takenAt);
                    if (postDate < sevenDaysAgo) return; // SKIP 7+ Day Old Data

                    const handle = i.ownerUsername || i.username || i.owner?.username;
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
            }
        }

        // METHOD 3: Hashtag Feed (With Dynamic Limit Scaling!)
        if (selected_methods.includes('method_3') && hashtags.length) {
            const cleanHashtags = hashtags.map(h => h.replace('#', '').trim()).filter(Boolean);
            
            // Dynamic limit ensures every hashtag gets exactly 40 posts checked
            const dynamicLimit = cleanHashtags.length * 40; 
            
            const items = await runActor('apify/instagram-hashtag-scraper', { hashtags: cleanHashtags, resultsLimit: dynamicLimit }, warnings);
            const posts = extractPosts(items);
            
            posts.forEach(i => {
                const postDate = new Date(i.timestamp || i.takenAt);
                if (postDate < sevenDaysAgo) return; // SKIP 7+ Day Old Data

                const handle = i.ownerUsername || i.username || i.owner?.username;
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

        // METHOD 3.1: Global Phrase (Plain Text Global Query)
        if (selected_methods.includes('method_3_1') && method3_1_keywords.length) {
            for (const kw of method3_1_keywords) {
                const items = await runActor('apify/instagram-api-scraper', { query: kw, limit: 40 }, warnings);
                const posts = extractPosts(items);
                
                posts.forEach(i => {
                    const postDate = new Date(i.timestamp || i.takenAt);
                    if (postDate < sevenDaysAgo) return; // SKIP 7+ Day Old Data

                    const handle = i.user?.username || i.ownerUsername || i.username;
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
        
        // Return warnings to the frontend so you aren't flying blind
        res.status(200).json({ success: true, newUniqueLeads: newLeadsSaved, warnings });

    } catch (err) {
        res.status(500).json({ error: err.message, warnings });
    }
});

// =========================================================================
// ROUTE 2: STAGE 2 ENRICHMENT (METHOD 2: PROFILE BIOS)
// =========================================================================
app.post('/api/enrich-campaign', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        const token = authHeader?.replace('Bearer ', '');
        const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
        if (authErr || !user) return res.status(401).json({ error: 'Unauthorized' });

        const { campaignId } = req.body;
        if (!campaignId) return res.status(400).json({ error: 'Campaign ID required' });

        // Database-Level Duplicate Check: Grab handles that ARE NOT enriched yet
        const { data: linkData, error: linkErr } = await supabase.from('campaign_leads')
            .select('leads(id, username, is_enriched)')
            .eq('campaign_id', campaignId);
            
        if (linkErr) throw linkErr;

        const handlesToEnrich = linkData
            .map(d => d.leads)
            .filter(l => l && l.is_enriched !== true)
            .map(l => l.username);

        // If everyone from this campaign is already in the DB and enriched from last week, skip Apify!
        if (handlesToEnrich.length === 0) return res.status(200).json({ message: 'All leads in this campaign are already enriched in your database!' });

        console.log(`[Stage 2] Running Method 2 on ${handlesToEnrich.length} profiles...`);
        const items = await runActor('apify/instagram-profile-scraper', { usernames: handlesToEnrich });

        let updatedCount = 0;
        for (const p of items) {
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
