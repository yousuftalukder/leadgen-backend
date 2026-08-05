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

// Stage 2: STRICTLY Profile Scraper (Bio, Email, Phone, Followers only)
async function enrichProfiles(usernames) {
    if (!usernames || !usernames.length) return [];
    
    console.log(`[Stage 2] Fetching Profile Bios for ${usernames.length} unique handles...`);
    const items = await runActor('apify/instagram-profile-scraper', { usernames });
    
    return items.map(p => {
        const username = (p.username || p.ownerUsername || p.handle || '').toLowerCase();
        if (!username) return null;
        return {
            username,
            full_name: p.fullName || p.full_name || null,
            email: p.biographyEmail || p.email || p.inputEmail || null,
            phone: p.businessPhoneNumber || p.phone || null,
            followers_count: p.followersCount || p.followers || 0,
            profile_url: `https://instagram.com/${username}`
        };
    }).filter(Boolean);
}

app.post('/api/run-campaign', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: 'Missing Authorization Header' });

        const token = authHeader.replace('Bearer ', '');
        const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
        if (authErr || !user) return res.status(401).json({ error: 'Unauthorized Client' });

        const { 
            campaignId, campaignName, location, 
            method1_keywords = [], hashtags = [], method3_1_keywords = [], selected_methods = [] 
        } = req.body;

        let activeCampaignId = campaignId;

        if (!activeCampaignId) {
            const { data: newCmp, error: cmpErr } = await supabase.from('campaigns').insert([{
                user_id: user.id,
                name: campaignName || `${location || 'Global'} Campaign`,
                location,
                keywords: [...method1_keywords, ...method3_1_keywords],
                selected_methods
            }]).select().single();

            if (cmpErr) throw cmpErr;
            activeCampaignId = newCmp.id;
        }

        let rawDiscoveredPosts = [];

        // =========================================================================
        // STAGE 1: POST INDEX DISCOVERY (Extracting Username + Post Views + Likes)
        // =========================================================================

        if (selected_methods.includes('method_1') && location) {
            const cities = location.split(',').map(c => c.trim()).filter(Boolean);
            const lowerKeywords = method1_keywords.map(k => k.toLowerCase().trim());
            
            for (const city of cities) {
                const items = await runActor('apify/instagram-scraper', { search: `${city} city`, searchType: 'place', resultsLimit: 30 });
                items.forEach(i => {
                    const handle = i.ownerUsername || i.username || i.owner?.username;
                    const caption = (i.caption || '').toLowerCase();
                    if (handle && (lowerKeywords.length === 0 || lowerKeywords.some(kw => caption.includes(kw)))) {
                        rawDiscoveredPosts.push({
                            username: handle,
                            post_views: i.videoViewCount || i.playCount || i.viewCount || 0,
                            post_likes: i.likesCount || 0,
                            post_url: i.url || `https://instagram.com/p/${i.shortCode}`
                        });
                    }
                });
            }
        }

        if (selected_methods.includes('method_3') && hashtags.length) {
            const cleanHashtags = hashtags.map(h => h.replace('#', '').trim()).filter(Boolean);
            const items = await runActor('apify/instagram-hashtag-scraper', { hashtags: cleanHashtags, resultsLimit: 50 });
            items.forEach(i => {
                const handle = i.ownerUsername || i.username || i.owner?.username;
                if (handle) {
                    rawDiscoveredPosts.push({
                        username: handle,
                        post_views: i.videoViewCount || i.playCount || i.viewCount || 0,
                        post_likes: i.likesCount || 0,
                        post_url: i.url || `https://instagram.com/p/${i.shortCode}`
                    });
                }
            });
        }

        if (selected_methods.includes('method_3_1') && method3_1_keywords.length) {
            for (const kw of method3_1_keywords) {
                const items = await runActor('apify/instagram-api-scraper', { query: kw, limit: 40 });
                items.forEach(i => {
                    const handle = i.user?.username || i.username || i.ownerUsername;
                    if (handle) {
                        rawDiscoveredPosts.push({
                            username: handle,
                            post_views: i.videoViewCount || i.playCount || i.viewCount || 0,
                            post_likes: i.likesCount || 0,
                            post_url: i.url || `https://instagram.com/p/${i.shortCode}`
                        });
                    }
                });
            }
        }

        // Deduplicate handles. If a user has multiple posts, keep the stats from the post with the highest views.
        const uniquePostMap = new Map();
        rawDiscoveredPosts.forEach(post => {
            const u = post.username.toLowerCase().trim().replace('@', '');
            if (!uniquePostMap.has(u) || post.post_views > uniquePostMap.get(u).post_views) {
                uniquePostMap.set(u, { ...post, username: u });
            }
        });

        const uniqueUsernames = Array.from(uniquePostMap.keys());
        console.log(`[Pipeline] Discovered ${uniqueUsernames.length} unique matching handles.`);

        // =========================================================================
        // STAGE 2: PROFILE ENRICHMENT & MERGE
        // =========================================================================
        const profileData = await enrichProfiles(uniqueUsernames);

        let newLeadsSaved = 0;

        for (const profile of profileData) {
            const stage1Post = uniquePostMap.get(profile.username);

            const { data: savedLead, error: leadErr } = await supabase.from('leads').upsert({
                username: profile.username,
                full_name: profile.full_name,
                email: profile.email,
                phone: profile.phone,
                followers_count: profile.followers_count,
                profile_url: profile.profile_url,
                sources_detected: selected_methods,
                avg_reel_views: stage1Post.post_views // Overwriting DB field temporarily to map to post views
            }, { onConflict: 'username' }).select().single();

            if (leadErr) continue;

            if (savedLead) {
                const { error: linkErr } = await supabase.from('campaign_leads').insert([{
                    campaign_id: activeCampaignId,
                    lead_id: savedLead.id,
                    user_id: user.id,
                    top_post_url: stage1Post.post_url,
                    top_post_views: stage1Post.post_views
                }]);

                if (!linkErr) newLeadsSaved++;
            }
        }

        const { data: currentCmp } = await supabase.from('campaigns').select('total_leads_found').eq('id', activeCampaignId).single();
        await supabase.from('campaigns').update({ total_leads_found: (currentCmp?.total_leads_found || 0) + newLeadsSaved }).eq('id', activeCampaignId);

        res.status(200).json({ success: true, campaignId: activeCampaignId, newUniqueLeads: newLeadsSaved, isExhausted: false });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/client-history', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        const token = authHeader?.replace('Bearer ', '');
        const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
        if (authErr || !user) return res.status(401).json({ error: 'Unauthorized' });

        // Joining the specific post views mapped in campaign_leads to show in UI
        const { data: campaigns, error: fetchErr } = await supabase.from('campaigns')
            .select('*, campaign_leads(top_post_views, leads(*))')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false });

        if (fetchErr) throw fetchErr;
        res.status(200).json({ campaigns });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Engine running on port ${PORT}`));
