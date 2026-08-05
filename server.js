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

// Helper: Generic Apify Runner
async function runActor(actorId, input) {
    try {
        console.log(`[Apify] Triggering ${actorId} with input:`, JSON.stringify(input));
        const run = await apify.actor(actorId).call(input);
        const { items } = await apify.dataset(run.defaultDatasetId).listItems();
        console.log(`[Apify] ${actorId} returned ${items ? items.length : 0} items.`);
        return items || [];
    } catch (err) {
        console.error(`[Apify Error] ${actorId}:`, err.message);
        return [];
    }
}

// Helper: Stage 2 Profile Data Enricher
async function enrichProfiles(usernames) {
    if (!usernames || !usernames.length) return [];
    
    const cleanUsernames = [...new Set(usernames.map(u => u?.toString().toLowerCase().trim().replace('@', '')))].filter(Boolean);
    if (!cleanUsernames.length) return [];

    console.log(`[Stage 2] Enriching ${cleanUsernames.length} unique profiles...`);
    const items = await runActor('apify/instagram-profile-scraper', { usernames: cleanUsernames });
    
    return items.map(p => {
        const username = (p.username || p.ownerUsername || p.handle || '').toLowerCase();
        if (!username) return null;
        return {
            username,
            full_name: p.fullName || p.full_name || null,
            email: p.biographyEmail || p.email || p.inputEmail || null,
            phone: p.businessPhoneNumber || p.phone || null,
            followers_count: p.followersCount || p.followers || 0,
            engagement_rate: p.engagementRate || 0,
            profile_url: `https://instagram.com/${username}`
        };
    }).filter(Boolean);
}

// Helper: Reel Metrics Fetcher
async function enrichReelsMetrics(usernames) {
    if (!usernames || !usernames.length) return {};
    const cleanUsernames = [...new Set(usernames.map(u => u?.toString().toLowerCase().trim().replace('@', '')))].filter(Boolean);
    if (!cleanUsernames.length) return {};

    console.log(`[Reels Fetcher] Fetching Reel views for ${cleanUsernames.length} handles...`);
    const items = await runActor('apify/instagram-reel-scraper', { usernames: cleanUsernames, resultsLimit: 3 });
    
    const metricsMap = {};
    items.forEach(item => {
        const u = (item.ownerUsername || item.username || item.owner?.username || '').toLowerCase();
        if (!u) return;
        if (!metricsMap[u]) metricsMap[u] = { views: [], topUrl: item.url || item.postUrl };
        const viewCount = item.playCount || item.videoViewCount || item.viewCount || 0;
        if (viewCount) metricsMap[u].views.push(viewCount);
    });

    const resultMap = {};
    Object.keys(metricsMap).forEach(u => {
        const views = metricsMap[u].views;
        const avg = views.length ? Math.round(views.reduce((a, b) => a + b, 0) / views.length) : 0;
        resultMap[u] = { 
            avg_reel_views: avg, 
            top_post_views: views.length ? Math.max(...views) : 0, 
            top_post_url: metricsMap[u].topUrl 
        };
    });
    return resultMap;
}

// =========================================================================
// MAIN ROUTE: RUN CAMPAIGN
// =========================================================================
app.post('/api/run-campaign', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: 'Missing Authorization Header' });

        const token = authHeader.replace('Bearer ', '');
        const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
        if (authErr || !user) return res.status(401).json({ error: 'Unauthorized Client' });

        const { 
            campaignId, 
            campaignName, 
            location, 
            keywords = [], 
            hashtags = [],
            selected_methods = [] 
        } = req.body;

        let activeCampaignId = campaignId;

        if (!activeCampaignId) {
            const { data: newCmp, error: cmpErr } = await supabase.from('campaigns').insert([{
                user_id: user.id,
                name: campaignName || `${location || 'Global'} Campaign`,
                location,
                keywords,
                selected_methods
            }]).select().single();

            if (cmpErr) throw cmpErr;
            activeCampaignId = newCmp.id;
        }

        let discoveredHandles = [];

        // =========================================================================
        // DISCOVERY STAGE
        // =========================================================================

        // Method 1: Multi-City Geofence + Caption Keyword Filtering
        if (selected_methods.includes('method_1') && location) {
            const cities = location.split(',').map(c => c.trim()).filter(Boolean);
            const lowerKeywords = keywords.map(k => k.toLowerCase().trim());
            
            for (const city of cities) {
                console.log(`[Method 1] Pulling posts for city: "${city}"...`);
                const items = await runActor('apify/instagram-scraper', { 
                    search: `${city} city`, 
                    searchType: 'place', 
                    resultsLimit: 30 
                });

                items.forEach(i => {
                    const handle = i.ownerUsername || i.username || i.owner?.username;
                    const caption = (i.caption || '').toLowerCase();
                    
                    // Engine-side caption filtering
                    if (handle) {
                        if (lowerKeywords.length > 0) {
                            const hasMatch = lowerKeywords.some(kw => caption.includes(kw));
                            if (hasMatch) discoveredHandles.push(handle);
                        } else {
                            discoveredHandles.push(handle);
                        }
                    }
                });
            }
        }

        // Method 3: Dedicated Hashtag Feed Search
        if (selected_methods.includes('method_3') && hashtags.length) {
            const cleanHashtags = hashtags.map(h => h.replace('#', '').trim()).filter(Boolean);
            console.log(`[Method 3] Executing hashtag scraper for:`, cleanHashtags);
            
            const items = await runActor('apify/instagram-hashtag-scraper', { 
                hashtags: cleanHashtags, 
                resultsLimit: 50 
            });

            items.forEach(i => {
                const handle = i.ownerUsername || i.username || i.owner?.username;
                if (handle) discoveredHandles.push(handle);
            });
        }

        // Method 3.1: Global Phrase Keyword Search Index
        if (selected_methods.includes('method_3_1') && keywords.length) {
            for (const kw of keywords) {
                console.log(`[Method 3.1] Searching global post index for keyword phrase: "${kw}"`);
                const items = await runActor('apify/instagram-api-scraper', { 
                    query: kw, 
                    limit: 40 
                });

                items.forEach(i => {
                    const handle = i.user?.username || i.username || i.ownerUsername;
                    if (handle) discoveredHandles.push(handle);
                });
            }
        }

        const uniqueHandles = [...new Set(discoveredHandles.map(u => u.toLowerCase().trim().replace('@', '')))].filter(Boolean);
        console.log(`[Pipeline] Discovered ${uniqueHandles.length} verified unique handles.`);

        // =========================================================================
        // STAGE 2: PROFILE & METRICS ENRICHMENT
        // =========================================================================
        let masterLeadBatch = await enrichProfiles(uniqueHandles);

        if (masterLeadBatch.length) {
            const reelsData = await enrichReelsMetrics(masterLeadBatch.map(l => l.username));
            masterLeadBatch = masterLeadBatch.map(l => ({
                ...l,
                avg_reel_views: reelsData[l.username]?.avg_reel_views || 0,
                top_post_views: reelsData[l.username]?.top_post_views || 0,
                top_post_url: reelsData[l.username]?.top_post_url || l.profile_url
            }));
        }

        // =========================================================================
        // DATABASE PERSISTENCE & DEDUPLICATION
        // =========================================================================
        let newLeadsSaved = 0;

        for (const lead of masterLeadBatch) {
            if (!lead.username) continue;

            const { data: savedLead, error: leadErr } = await supabase.from('leads').upsert({
                username: lead.username,
                full_name: lead.full_name || null,
                email: lead.email || null,
                phone: lead.phone || null,
                followers_count: lead.followers_count || 0,
                engagement_rate: lead.engagement_rate || 0,
                avg_reel_views: lead.avg_reel_views || 0,
                profile_url: lead.profile_url || `https://instagram.com/${lead.username}`,
                sources_detected: selected_methods
            }, { onConflict: 'username' }).select().single();

            if (leadErr) continue;

            if (savedLead) {
                const { error: linkErr } = await supabase.from('campaign_leads').insert([{
                    campaign_id: activeCampaignId,
                    lead_id: savedLead.id,
                    user_id: user.id,
                    top_post_url: lead.top_post_url || lead.profile_url,
                    top_post_views: lead.top_post_views || 0
                }]);

                if (!linkErr) newLeadsSaved++;
            }
        }

        const { data: currentCmp } = await supabase.from('campaigns')
            .select('total_leads_found')
            .eq('id', activeCampaignId)
            .single();

        const currentCount = currentCmp?.total_leads_found || 0;

        await supabase.from('campaigns').update({
            total_leads_found: currentCount + newLeadsSaved
        }).eq('id', activeCampaignId);

        res.status(200).json({
            success: true,
            campaignId: activeCampaignId,
            newUniqueLeads: newLeadsSaved,
            isExhausted: false
        });

    } catch (err) {
        console.error('[Server Execution Error]:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/client-history', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        const token = authHeader?.replace('Bearer ', '');
        
        const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
        if (authErr || !user) return res.status(401).json({ error: 'Unauthorized' });

        const { data: campaigns, error: fetchErr } = await supabase.from('campaigns')
            .select('*, campaign_leads(leads(*))')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false });

        if (fetchErr) throw fetchErr;

        res.status(200).json({ campaigns });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/health', (req, res) => res.status(200).send('LeadGen Backend Active'));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Engine running on port ${PORT}`));
