const express = require('express');
const cors = require('cors');
const { ApifyClient } = require('apify-client');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// Initialize Apify & Supabase Service Role Clients
const apify = new ApifyClient({ token: process.env.APIFY_API_TOKEN });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Helper: Generic Apify Runner Helper
async function runActor(actorId, input) {
    console.log(`[Apify] Triggering ${actorId}...`);
    const run = await apify.actor(actorId).call(input);
    const { items } = await apify.dataset(run.defaultDatasetId).listItems();
    return { 
        items, 
        endCursor: run.customData?.endCursor || null, 
        hasNextPage: items.length > 0 
    };
}

// Helper: Stage 2 Profile & Email Enricher (Method 2)
async function enrichProfiles(usernames) {
    if (!usernames || !usernames.length) return [];
    console.log(`[Stage 2] Enriching ${usernames.length} unique profiles...`);
    
    // De-duplicate usernames before passing to Apify
    const cleanUsernames = [...new Set(usernames.map(u => u.toLowerCase().trim()))];
    const { items } = await runActor('apify/instagram-profile-scraper', { usernames: cleanUsernames });
    
    return items.map(p => ({
        username: p.username?.toLowerCase(),
        full_name: p.fullName || null,
        email: p.biographyEmail || p.inputEmail || null,
        phone: p.businessPhoneNumber || null,
        followers_count: p.followersCount || 0,
        engagement_rate: p.engagementRate || 0,
        profile_url: `https://instagram.com/${p.username}`
    }));
}

// Helper: Method 5 & 6 Reels Enrichment (Fetches Views for Text-Based Searches)
async function enrichReelsMetrics(usernames) {
    if (!usernames || !usernames.length) return {};
    console.log(`[Reels Fetcher] Fetching recent Reel views for text-search handles...`);
    
    const cleanUsernames = [...new Set(usernames.map(u => u.toLowerCase().trim()))];
    const { items } = await runActor('apify/instagram-reel-scraper', { usernames: cleanUsernames, resultsLimit: 5 });
    
    const metricsMap = {};
    items.forEach(item => {
        const u = item.ownerUsername?.toLowerCase();
        if (!u) return;
        if (!metricsMap[u]) metricsMap[u] = { views: [], topUrl: item.url };
        if (item.playCount || item.videoViewCount) {
            metricsMap[u].views.push(item.playCount || item.videoViewCount);
        }
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
        // 1. Authenticate Client via Supabase JWT Header
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
            selected_methods = [], 
            minViews = 5000 
        } = req.body;

        let activeCampaignId = campaignId;
        let cursor = null;

        // 2. Load Existing Campaign Cursor or Initialize New Campaign
        if (activeCampaignId) {
            const { data: cmp } = await supabase.from('campaigns')
                .select('end_cursor, is_exhausted')
                .eq('id', activeCampaignId)
                .single();

            if (cmp?.is_exhausted) {
                return res.status(200).json({ message: 'Market Fully Exhausted for this search state!' });
            }
            cursor = cmp?.end_cursor;
        } else {
            const { data: newCmp, error: cmpErr } = await supabase.from('campaigns').insert([{
                user_id: user.id,
                name: campaignName || `${location} Campaign`,
                location,
                keywords,
                selected_methods
            }]).select().single();

            if (cmpErr) throw cmpErr;
            activeCampaignId = newCmp.id;
        }

        let rawPosts = [];
        let directHandles = [];
        let hasNextPageGlobal = false;
        let lastEndCursor = null;

        // =========================================================================
        // 3. THE 7 INDIVIDUAL DISCOVERY METHODS (MODULAR EXECUTION)
        // =========================================================================

        // Method 1: Location Feed
        if (selected_methods.includes('method_1')) {
            const result = await runActor('apify/instagram-scraper', { search: location, searchType: 'place', startCursor: cursor });
            rawPosts.push(...result.items);
            hasNextPageGlobal = result.hasNextPage;
            lastEndCursor = result.endCursor;
        }

        // Method 2: Profile Scrape (Executed directly if passed as a stage 1 list)
        if (selected_methods.includes('method_2')) {
            const enrichedDirect = await enrichProfiles(keywords);
            directHandles.push(...enrichedDirect);
        }

        // Method 3: Hashtag Feed
        if (selected_methods.includes('method_3')) {
            const result = await runActor('apify/instagram-hashtag-scraper', { hashtags: keywords, startCursor: cursor });
            rawPosts.push(...result.items);
            hasNextPageGlobal = result.hasNextPage;
            lastEndCursor = result.endCursor;
        }

        // Method 4: Tagged Posts Feed
        if (selected_methods.includes('method_4')) {
            const result = await runActor('apify/instagram-scraper', { search: keywords[0] || location, searchType: 'hashtag', startCursor: cursor });
            rawPosts.push(...result.items);
        }

        // Method 5: Google Dorking
        if (selected_methods.includes('method_5')) {
            const query = `site:instagram.com "${keywords[0] || ''}" "${location}" "gmail.com"`;
            const { items } = await runActor('apify/google-search-scraper', { queries: query });
            const extracted = items.map(i => {
                const title = i.title || '';
                return title.split('(')[0].replace('Instagram:', '').replace('@', '').trim();
            }).filter(Boolean);

            directHandles.push(...extracted.map(u => ({ username: u.toLowerCase() })));
        }

        // Method 6: TopSearch API
        if (selected_methods.includes('method_6')) {
            const { items } = await runActor('apify/instagram-api-scraper', { query: `${keywords[0] || ''} ${location}` });
            const extracted = items.map(i => i.user?.username?.toLowerCase()).filter(Boolean);
            directHandles.push(...extracted.map(u => ({ username: u })));
        }

        // Method 7: Audio Track Feed
        if (selected_methods.includes('method_7')) {
            const result = await runActor('apify/instagram-reel-scraper', { audioId: keywords[0], startCursor: cursor });
            rawPosts.push(...result.items);
        }

        // =========================================================================
        // 4. PIPELINE STAGE 1 -> STAGE 2 FILTERING & ENRICHMENT
        // =========================================================================

        // Filter Stage 1 raw feed posts by view threshold
        const winningFeedPosts = rawPosts.filter(p => (p.playCount || p.videoViewCount || 0) >= minViews);
        const winningHandlesFromFeed = [...new Set(winningFeedPosts.map(p => p.ownerUsername?.toLowerCase()).filter(Boolean))];

        // Trigger Stage 2 Profile Scrape ONLY on winning handles
        const enrichedFeedLeads = await enrichProfiles(winningHandlesFromFeed);
        
        // Merge enriched feed leads with direct handles (Methods 2, 5, 6)
        let masterLeadBatch = [...enrichedFeedLeads, ...directHandles];

        // Process Method 5 & 6 text handles through the Reels Enrichment step
        const textOnlyUsernames = directHandles.map(m => m.username).filter(Boolean);
        if (textOnlyUsernames.length) {
            const reelsData = await enrichReelsMetrics(textOnlyUsernames);
            masterLeadBatch = masterLeadBatch.map(l => ({
                ...l,
                avg_reel_views: reelsData[l.username]?.avg_reel_views || l.avg_reel_views || 0,
                top_post_views: reelsData[l.username]?.top_post_views || 0,
                top_post_url: reelsData[l.username]?.top_post_url || l.profile_url
            }));
        }

        // =========================================================================
        // 5. DATABASE PERSISTENCE & MULTI-TENANT DEDUPLICATION
        // =========================================================================
        let newLeadsSaved = 0;

        for (const lead of masterLeadBatch) {
            if (!lead.username) continue;

            // Upsert into Global Master Leads Vault
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

            if (leadErr) {
                console.error(`Error upserting lead @${lead.username}:`, leadErr.message);
                continue;
            }

            // Link Lead to the Authenticated Client's Campaign
            if (savedLead) {
                const { error: linkErr } = await supabase.from('campaign_leads').insert([{
                    campaign_id: activeCampaignId,
                    lead_id: savedLead.id,
                    user_id: user.id,
                    top_post_url: lead.top_post_url || lead.profile_url,
                    top_post_views: lead.top_post_views || 0
                }]);

                // Ignore duplicate links (unique constraint handles this)
                if (!linkErr) newLeadsSaved++;
            }
        }

        // Update Campaign State, Total Count, and Pagination Cursor
        await supabase.from('campaigns').update({
            end_cursor: lastEndCursor,
            is_exhausted: !hasNextPageGlobal && rawPosts.length > 0,
            total_leads_found: supabase.raw('total_leads_found + ?', [newLeadsSaved])
        }).eq('id', activeCampaignId);

        res.status(200).json({
            success: true,
            campaignId: activeCampaignId,
            newUniqueLeads: newLeadsSaved,
            isExhausted: !hasNextPageGlobal && rawPosts.length > 0
        });

    } catch (err) {
        console.error('[Server Error]:', err);
        res.status(500).json({ error: err.message });
    }
});

// =========================================================================
// HISTORICAL BATCHES ROUTE (FOR CLIENT DASHBOARD)
// =========================================================================
app.get('/api/client-history', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        const token = authHeader?.replace('Bearer ', '');
        
        const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
        if (authErr || !user) return res.status(401).json({ error: 'Unauthorized' });

        // Fetch client's isolated campaigns with linked lead details
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

// Health check route
app.get('/health', (req, res) => res.status(200).send('LeadGen Backend Active'));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Engine running on port ${PORT}`));
