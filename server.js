const express = require('express');
const cors = require('cors');
const { ApifyClient } = require('apify-client');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// Dynamic In-Memory API Key Management
let ACTIVE_APIFY_TOKEN = process.env.APIFY_API_TOKEN;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function getApifyClient() {
    return new ApifyClient({ token: ACTIVE_APIFY_TOKEN });
}

// Universal View Extractor across all post types (Photos, Carousels, Reels)
function getViews(i) {
    return i.videoPlayCount || i.playCount || i.videoViewCount || i.viewCount || i.reelsCount || 0;
}

function extractPosts(items) {
    let posts = [];
    (items || []).forEach(item => {
        if (item.ownerUsername || item.shortCode || item.caption) posts.push(item);
        if (item.topPosts && Array.isArray(item.topPosts)) posts.push(...item.topPosts);
        if (item.latestPosts && Array.isArray(item.latestPosts)) posts.push(...item.latestPosts);
    });
    return posts;
}

async function runActor(actorId, input, warningsArray, methodName) {
    try {
        console.log(`[Apify] Triggering ${actorId} for ${methodName}...`);
        const client = getApifyClient();
        const run = await client.actor(actorId).call(input);
        const { items } = await client.dataset(run.defaultDatasetId).listItems();
        
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
// SYSTEM CONTROL & MANAGEMENT ENDPOINTS
// =========================================================================

// Check Actor Connectivity & Key Status
app.get('/api/actor-status', async (req, res) => {
    try {
        const client = getApifyClient();
        const user = await client.user().get();
        res.status(200).json({ active: true, username: user.username });
    } catch (err) {
        res.status(200).json({ active: false, error: "Invalid/Expired Key" });
    }
});

// Update Apify Key Dynamically from UI
app.post('/api/update-apify-key', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        const token = authHeader?.replace('Bearer ', '');
        const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
        if (authErr || !user) return res.status(401).json({ error: 'Unauthorized' });

        const { newApiKey } = req.body;
        if (!newApiKey) return res.status(400).json({ error: 'Key required' });

        const testClient = new ApifyClient({ token: newApiKey });
        await testClient.user().get();

        ACTIVE_APIFY_TOKEN = newApiKey;
        console.log('[System] Apify API Key updated successfully in runtime memory.');
        res.status(200).json({ success: true, message: 'Apify Key updated and verified!' });
    } catch (err) {
        res.status(400).json({ error: 'Key verification failed: ' + err.message });
    }
});

// Delete Campaign Endpoint
app.delete('/api/campaign/:id', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        const token = authHeader?.replace('Bearer ', '');
        const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
        if (authErr || !user) return res.status(401).json({ error: 'Unauthorized' });

        const campaignId = req.params.id;
        const { error: delErr } = await supabase.from('campaigns').delete().eq('id', campaignId).eq('user_id', user.id);
        
        if (delErr) throw delErr;
        res.status(200).json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Search Leads Globally Across All Campaigns
app.get('/api/search-leads', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        const token = authHeader?.replace('Bearer ', '');
        const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
        if (authErr || !user) return res.status(401).json({ error: 'Unauthorized' });

        const query = req.query.q ? req.query.q.toLowerCase().trim().replace('@', '') : '';
        if (!query) return res.status(400).json({ error: 'Query required' });

        const { data: leads, error } = await supabase
            .from('leads')
            .select('*, campaign_leads(top_post_views, post_likes, post_comments, post_timestamp, top_post_url, campaigns(name))')
            .or(`username.ilike.%${query}%,full_name.ilike.%${query}%,email.ilike.%${query}%`)
            .limit(50);

        if (error) throw error;
        res.status(200).json({ leads });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =========================================================================
// STAGE 1 DISCOVERY PIPELINE
// =========================================================================

app.post('/api/run-campaign', async (req, res) => {
    let warnings = []; 
    try {
        const authHeader = req.headers.authorization;
        const token = authHeader?.replace('Bearer ', '');
        const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
        if (authErr || !user) return res.status(401).json({ error: 'Unauthorized' });

        const { 
            campaignName, location, method1_keywords = [], hashtags = [], 
            method3_1_keywords = [], competitor_handles = [], method6_keywords = [], 
            selected_methods = [] 
        } = req.body;

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

        // METHOD 1: Location URL Feed
        if (selected_methods.includes('method_1') && location) {
            const locInputs = location.split(',').map(c => c.trim()).filter(Boolean);
            const directUrls = locInputs.filter(loc => loc.includes('instagram.com/explore/locations'));
            
            if (directUrls.length > 0) {
                const lowerKeywords = method1_keywords.map(k => k.toLowerCase().trim());
                const posts = await runActor('apify/instagram-scraper', { 
                    directUrls, 
                    resultsLimit: 1000,
                    scrollWaitSecs: 5,
                    pageTimeoutSecs: 60
                }, warnings, `Method 1 (Locations)`);
                
                posts.forEach(i => {
                    const handle = i.ownerUsername || i.owner?.username || i.username || i.user?.username;
                    const caption = (i.caption || i.text || '').toLowerCase();
                    if (handle && (lowerKeywords.length === 0 || lowerKeywords.some(kw => caption.includes(kw)))) {
                        rawDiscoveredPosts.push({
                            username: handle, 
                            post_views: getViews(i),
                            post_likes: i.likesCount || 0, 
                            post_comments: i.commentsCount || 0,
                            post_timestamp: i.timestamp || i.takenAt || new Date().toISOString(), 
                            post_url: i.url || `https://instagram.com/p/${i.shortCode}`
                        });
                    }
                });
            } else { warnings.push("⚠️ METHOD 1 SKIPPED: Location requires direct Instagram URL."); }
        }

        // METHOD 3: Hashtag Feed
        if (selected_methods.includes('method_3') && hashtags.length) {
            const cleanHashtags = hashtags.map(h => h.replace('#', '').trim()).filter(Boolean);
            const directUrls = cleanHashtags.map(tag => `https://www.instagram.com/explore/tags/${tag}/`);
            
            const posts = await runActor('apify/instagram-scraper', { 
                directUrls, 
                resultsLimit: 1000,
                scrollWaitSecs: 5,
                pageTimeoutSecs: 60
            }, warnings, 'Method 3 (Hashtags)');
            
            posts.forEach(i => {
                const handle = i.ownerUsername || i.owner?.username || i.username || i.user?.username;
                if (handle) {
                    rawDiscoveredPosts.push({
                        username: handle, 
                        post_views: getViews(i),
                        post_likes: i.likesCount || 0, 
                        post_comments: i.commentsCount || 0,
                        post_timestamp: i.timestamp || i.takenAt || new Date().toISOString(), 
                        post_url: i.url || `https://instagram.com/p/${i.shortCode}`
                    });
                }
            });
        }

        // METHOD 3.1: Global Phrase Search
        if (selected_methods.includes('method_3_1') && method3_1_keywords.length) {
            for (const kw of method3_1_keywords) {
                const posts = await runActor('apify/instagram-api-scraper', { query: kw, limit: 1000 }, warnings, `Method 3.1 (${kw})`);
                posts.forEach(i => {
                    const handle = i.ownerUsername || i.owner?.username || i.username || i.user?.username;
                    if (handle) {
                        rawDiscoveredPosts.push({
                            username: handle, 
                            post_views: getViews(i),
                            post_likes: i.likesCount || 0, 
                            post_comments: i.commentsCount || 0,
                            post_timestamp: i.timestamp || i.takenAt || new Date().toISOString(), 
                            post_url: i.url || `https://instagram.com/p/${i.shortCode}`
                        });
                    }
                });
            }
        }

        // METHOD 4: Competitor Tagged Feed (Deep Scroll Integration)
        if (selected_methods.includes('method_4') && competitor_handles.length) {
            const cleanHandles = competitor_handles.map(h => h.replace('@', '').trim()).filter(Boolean);
            const taggedUrls = cleanHandles.map(handle => `https://www.instagram.com/${handle}/tagged/`);
            
            const posts = await runActor('apify/instagram-scraper', { 
                directUrls: taggedUrls, 
                resultsLimit: 1000,
                scrollWaitSecs: 5,
                pageTimeoutSecs: 60
            }, warnings, 'Method 4 (Competitor Tagged)');
            
            posts.forEach(i => {
                const handle = i.ownerUsername || i.owner?.username || i.username || i.user?.username;
                if (handle) {
                    rawDiscoveredPosts.push({
                        username: handle, 
                        post_views: getViews(i),
                        post_likes: i.likesCount || 0, 
                        post_comments: i.commentsCount || 0,
                        post_timestamp: i.timestamp || i.takenAt || new Date().toISOString(), 
                        post_url: i.url || `https://instagram.com/p/${i.shortCode}`
                    });
                }
            });
        }

        // METHOD 6: TopSearch B2B Accounts
        if (selected_methods.includes('method_6') && method6_keywords.length) {
            for (const kw of method6_keywords) {
                const client = getApifyClient();
                try {
                    const run = await client.actor('apify/instagram-search-scraper').call({ searchQueries: [kw], searchType: 'user' });
                    const { items } = await client.dataset(run.defaultDatasetId).listItems();
                    
                    (items || []).forEach(item => {
                        const handle = item.username || item.ownerUsername;
                        if (handle) {
                            rawDiscoveredPosts.push({
                                username: handle, 
                                post_views: 0, 
                                post_likes: 0, 
                                post_comments: 0,
                                post_timestamp: new Date().toISOString(), 
                                post_url: `https://instagram.com/${handle}`
                            });
                        }
                    });
                    warnings.push(`X-RAY (Method 6): Found ${items?.length || 0} account profiles for "${kw}".`);
                } catch (e) {
                    warnings.push(`🚨 Error (Method 6): ${e.message}`);
                }
            }
        }

        // Deduplicate locally across all active methods
        const uniquePostMap = new Map();
        rawDiscoveredPosts.forEach(post => {
            const u = post.username.toLowerCase().trim().replace('@', '');
            if (!uniquePostMap.has(u) || post.post_views > uniquePostMap.get(u).post_views) {
                uniquePostMap.set(u, { ...post, username: u });
            }
        });

        const uniquePosts = Array.from(uniquePostMap.values());
        let newLeadsSaved = 0;

        for (const post of uniquePosts) {
            let savedLeadId = null;
            const { data: existingLead } = await supabase.from('leads').select('id').eq('username', post.username).maybeSingle(); 
            
            if (existingLead) {
                savedLeadId = existingLead.id;
            } else {
                const { data: newLead, error: insertErr } = await supabase.from('leads').insert([{
                    username: post.username, profile_url: `https://instagram.com/${post.username}`, is_enriched: false
                }]).select('id').maybeSingle();

                if (insertErr) { warnings.push(`DB Alert: Failed to save @${post.username}`); continue; }
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
                
                if (!linkErr) newLeadsSaved++;
            }
        }

        await supabase.from('campaigns').update({ total_leads_found: newLeadsSaved }).eq('id', activeCampaignId);
        res.status(200).json({ success: true, newUniqueLeads: newLeadsSaved, warnings });

    } catch (err) {
        res.status(500).json({ error: err.message, warnings });
    }
});

// =========================================================================
// STAGE 2 ENRICHMENT PIPELINE (METHOD 2 - TIMEOUT & BATCH PROTECTED)
// =========================================================================

app.post('/api/enrich-campaign', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        const token = authHeader?.replace('Bearer ', '');
        const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
        if (authErr || !user) return res.status(401).json({ error: 'Unauthorized' });

        const { campaignId } = req.body;
        if (!campaignId) return res.status(400).json({ error: 'Campaign ID required' });

        const { data: linkData, error: linkErr } = await supabase.from('campaign_leads').select('leads(id, username, is_enriched)').eq('campaign_id', campaignId);
        if (linkErr) throw linkErr;

        // BATCHING FIX: Caps array to 25 handles per request to stay under Render's 30s timeout
        const handlesToEnrich = linkData.map(d => d.leads).filter(l => l && l.is_enriched !== true).map(l => l.username).slice(0, 25);
        if (handlesToEnrich.length === 0) return res.status(200).json({ success: true, message: 'All leads enriched!', enrichedCount: 0 });

        const client = getApifyClient();
        
        // TIMEOUT FIX: Added { waitSecs: 25 } execution barrier
        const run = await client.actor('apify/instagram-profile-scraper').call({ usernames: handlesToEnrich }, { waitSecs: 25 });
        const { items: enrichedProfiles } = await client.dataset(run.defaultDatasetId).listItems();

        let updatedCount = 0;
        for (const p of (enrichedProfiles || [])) {
            const username = (p.username || p.ownerUsername || '').toLowerCase().trim();
            if (!username) continue;

            const email = p.biographyEmail || p.email || p.inputEmail || p.businessEmail || null;
            const phone = p.businessPhoneNumber || p.phone || p.phoneNumber || null;
            const fullName = p.fullName || p.full_name || p.name || null;
            const followers = p.followersCount !== undefined ? p.followersCount : (p.followers || 0);

            const { error: updateErr } = await supabase.from('leads').update({
                full_name: fullName, 
                email: email,
                phone: phone, 
                followers_count: followers,
                is_enriched: true
            }).eq('username', username);

            if (!updateErr) updatedCount++;
        }

        res.status(200).json({ success: true, enrichedCount: updatedCount });

    } catch (err) {
        console.error('[Enrich Error]:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// =========================================================================
// MASTER HISTORY & VAULT FETCH
// =========================================================================

app.get('/api/client-history', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        const token = authHeader?.replace('Bearer ', '');
        const { data: { user } } = await supabase.auth.getUser(token);
        
        const { data: campaigns } = await supabase.from('campaigns')
            .select('*, campaign_leads(top_post_views, post_likes, post_comments, post_timestamp, top_post_url, leads(*))')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false });

        res.status(200).json({ campaigns });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
// =========================================================================
// INSTAGRAM REPORT GENERATOR ENDPOINT
// =========================================================================

app.post('/api/generate-ig-report', async (req, res) => {
    try {
        const { apiKey, target, compareRivals, rival1, rival2 } = req.body;
        const activeToken = apiKey || ACTIVE_APIFY_TOKEN;
        const client = new ApifyClient({ token: activeToken });

        async function auditHandle(handle) {
            const cleanHandle = handle.replace('@', '').trim();
            if (!cleanHandle) return null;

            // 1. Fetch Profile Header Data
            const profileRun = await client.actor('apify/instagram-profile-scraper').call({ usernames: [cleanHandle] });
            const { items: profiles } = await client.dataset(profileRun.defaultDatasetId).listItems();
            const prof = profiles[0] || {};

            const followers = prof.followersCount || prof.followers || 0;

            // 2. Fetch Sample Recent Posts
            const postRun = await client.actor('apify/instagram-scraper').call({
                directUrls: [`https://www.instagram.com/${cleanHandle}/`],
                resultsLimit: 30
            });
            const { items: rawPosts } = await client.dataset(postRun.defaultDatasetId).listItems();
            const posts = extractPosts(rawPosts || []);

            if (posts.length === 0) {
                return { handle: cleanHandle, followers, engagementRate: '0.0', viralityScore: '0.0', postsPerWeek: '0.0', grade: 'C', topPosts: [] };
            }

            // Calculate Engagement, Virality & Velocity
            let totalLikes = 0, totalComments = 0, totalViews = 0;
            posts.forEach(p => {
                totalLikes += p.likesCount || 0;
                totalComments += p.commentsCount || 0;
                totalViews += getViews(p);
            });

            const avgInteractions = (totalLikes + totalComments) / posts.length;
            const engagementRate = followers > 0 ? ((avgInteractions / followers) * 100).toFixed(2) : '0.0';

            const avgViews = totalViews / posts.length;
            const viralityScore = followers > 0 ? (avgViews / followers).toFixed(2) : '0.0';

            // Calculate Posting Velocity (Posts per Week)
            const timestamps = posts.map(p => new Date(p.timestamp || p.takenAt || Date.now()).getTime()).sort((a,b) => a - b);
            const daysSpan = Math.max(1, (timestamps[timestamps.length - 1] - timestamps[0]) / (1000 * 3600 * 24));
            const postsPerWeek = ((posts.length / daysSpan) * 7).toFixed(1);

            // Grade Calculation
            let grade = 'B';
            if (parseFloat(engagementRate) > 3.0 && parseFloat(viralityScore) > 1.0) grade = 'A+';
            else if (parseFloat(engagementRate) > 1.5) grade = 'A';
            else if (parseFloat(engagementRate) < 0.8) grade = 'C';

            // Sort Top 3 Posts
            const topPosts = posts.sort((a,b) => (b.likesCount || 0) - (a.likesCount || 0)).slice(0, 3).map(p => ({
                likes: p.likesCount || 0,
                comments: p.commentsCount || 0,
                views: getViews(p),
                type: p.type || (p.videoPlayCount ? 'Reel' : 'Post'),
                caption: p.caption || ''
            }));

            return { handle: cleanHandle, followers, engagementRate, viralityScore, postsPerWeek, grade, topPosts };
        }

        const mainAudit = await auditHandle(target);
        let rivalAudits = [];

        if (compareRivals) {
            if (rival1) { const r1 = await auditHandle(rival1); if (r1) rivalAudits.push(r1); }
            if (rival2) { const r2 = await auditHandle(rival2); if (r2) rivalAudits.push(r2); }
        }

        // Generate Recommendations
        let recommendations = [];
        if (parseFloat(mainAudit.engagementRate) < 1.5) {
            recommendations.push(`Increase audience interaction by ending captions with direct questions and using multi-slide Carousels.`);
        }
        if (parseFloat(mainAudit.viralityScore) < 0.8) {
            recommendations.push(`Reel play counts are trailing follower totals. Transition 50% of static image posts into short 7-15 second trending Reels to hit Instagram's Explore algorithm.`);
        }
        if (parseFloat(mainAudit.postsPerWeek) < 3.0) {
            recommendations.push(`Posting consistency is low (${mainAudit.postsPerWeek} posts/week). Target a baseline of 4-5 weekly posts to prevent algorithmic drop-off.`);
        }
        if (recommendations.length === 0) {
            recommendations.push(`Strong overall account health! Maintain current Reel frequency and scale high-performing content formats.`);
        }

        res.status(200).json({
            success: true,
            report: { main: mainAudit, rivals: rivalAudits, recommendations }
        });

    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});
    
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Engine active on port ${PORT}`));

// =========================================================================
// INSTAGRAM REPORT GENERATOR ENDPOINT (USES BACKEND ACTIVE KEY BY DEFAULT)
// =========================================================================

app.post('/api/generate-ig-report', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        const token = authHeader?.replace('Bearer ', '');
        const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
        if (authErr || !user) return res.status(401).json({ error: 'Unauthorized' });

        const { apiKey, target, compareRivals, rival1, rival2 } = req.body;
        
        // Use custom override key if provided, otherwise fallback to runtime active key
        const activeToken = apiKey ? apiKey : ACTIVE_APIFY_TOKEN;
        const client = new ApifyClient({ token: activeToken });

        async function auditHandle(handle) {
            const cleanHandle = handle.replace('@', '').trim();
            if (!cleanHandle) return null;

            const profileRun = await client.actor('apify/instagram-profile-scraper').call({ usernames: [cleanHandle] });
            const { items: profiles } = await client.dataset(profileRun.defaultDatasetId).listItems();
            const prof = profiles[0] || {};
            const followers = prof.followersCount || prof.followers || 0;

            const postRun = await client.actor('apify/instagram-scraper').call({
                directUrls: [`https://www.instagram.com/${cleanHandle}/`],
                resultsLimit: 30
            });
            const { items: rawPosts } = await client.dataset(postRun.defaultDatasetId).listItems();
            const posts = extractPosts(rawPosts || []);

            if (posts.length === 0) {
                return { handle: cleanHandle, followers, engagementRate: '0.0', viralityScore: '0.0', postsPerWeek: '0.0', grade: 'C', topPosts: [] };
            }

            let totalLikes = 0, totalComments = 0, totalViews = 0;
            posts.forEach(p => {
                totalLikes += p.likesCount || 0;
                totalComments += p.commentsCount || 0;
                totalViews += getViews(p);
            });

            const avgInteractions = (totalLikes + totalComments) / posts.length;
            const engagementRate = followers > 0 ? ((avgInteractions / followers) * 100).toFixed(2) : '0.0';
            const avgViews = totalViews / posts.length;
            const viralityScore = followers > 0 ? (avgViews / followers).toFixed(2) : '0.0';

            const timestamps = posts.map(p => new Date(p.timestamp || p.takenAt || Date.now()).getTime()).sort((a,b) => a - b);
            const daysSpan = Math.max(1, (timestamps[timestamps.length - 1] - timestamps[0]) / (1000 * 3600 * 24));
            const postsPerWeek = ((posts.length / daysSpan) * 7).toFixed(1);

            let grade = 'B';
            if (parseFloat(engagementRate) > 3.0 && parseFloat(viralityScore) > 1.0) grade = 'A+';
            else if (parseFloat(engagementRate) > 1.5) grade = 'A';
            else if (parseFloat(engagementRate) < 0.8) grade = 'C';

            const topPosts = posts.sort((a,b) => (b.likesCount || 0) - (a.likesCount || 0)).slice(0, 3).map(p => ({
                likes: p.likesCount || 0,
                comments: p.commentsCount || 0,
                views: getViews(p),
                type: p.type || (p.videoPlayCount ? 'Reel' : 'Post'),
                caption: p.caption || ''
            }));

            return { handle: cleanHandle, followers, engagementRate, viralityScore, postsPerWeek, grade, topPosts };
        }

        const mainAudit = await auditHandle(target);
        let rivalAudits = [];

        if (compareRivals) {
            if (rival1) { const r1 = await auditHandle(rival1); if (r1) rivalAudits.push(r1); }
            if (rival2) { const r2 = await auditHandle(rival2); if (r2) rivalAudits.push(r2); }
        }

        let recommendations = [];
        if (parseFloat(mainAudit.engagementRate) < 1.5) {
            recommendations.push(`Increase audience interaction by ending captions with direct questions and using multi-slide Carousels.`);
        }
        if (parseFloat(mainAudit.viralityScore) < 0.8) {
            recommendations.push(`Reel play counts are trailing follower totals. Transition 50% of static image posts into short 7-15 second trending Reels to hit Instagram's Explore algorithm.`);
        }
        if (parseFloat(mainAudit.postsPerWeek) < 3.0) {
            recommendations.push(`Posting consistency is low (${mainAudit.postsPerWeek} posts/week). Target a baseline of 4-5 weekly posts to prevent algorithmic drop-off.`);
        }
        if (recommendations.length === 0) {
            recommendations.push(`Strong overall account health! Maintain current Reel frequency and scale high-performing content formats.`);
        }

        const fullReportPayload = { main: mainAudit, rivals: rivalAudits, recommendations };

        // Save report entry into Supabase Vault
        await supabase.from('reports').insert([{
            user_id: user.id,
            platform: 'instagram',
            target_handle: mainAudit.handle,
            grade: mainAudit.grade,
            engagement_rate: parseFloat(mainAudit.engagementRate),
            report_json: fullReportPayload
        }]);

        res.status(200).json({ success: true, report: fullReportPayload });

    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Fetch Dedicated Reports Vault History
app.get('/api/reports-history', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        const token = authHeader?.replace('Bearer ', '');
        const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
        if (authErr || !user) return res.status(401).json({ error: 'Unauthorized' });

        const { data: reports, error } = await supabase
            .from('reports')
            .select('*')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.status(200).json({ reports });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Separate runtime token variables in server.js
let LEADGEN_APIFY_TOKEN = process.env.APIFY_API_KEY;
let REPORT_APIFY_TOKEN = process.env.APIFY_API_KEY;

// Updated Key Ingestion Endpoint
app.post('/api/update-apify-key', async (req, res) => {
    try {
        const { newApiKey, engine } = req.body;
        
        if (engine === 'report') {
            REPORT_APIFY_TOKEN = newApiKey;
            console.log('✅ Updated IG Performance Audit Apify Token');
        } else {
            LEADGEN_APIFY_TOKEN = newApiKey;
            console.log('✅ Updated Lead Finder Apify Token');
        }

        res.status(200).json({ success: true, engine: engine || 'leadgen' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Update Report Route to explicitly use REPORT_APIFY_TOKEN
app.post('/api/generate-ig-report', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        const token = authHeader?.replace('Bearer ', '');
        const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
        if (authErr || !user) return res.status(401).json({ error: 'Unauthorized' });

        const { target, compareRivals, rival1, rival2 } = req.body;
        
        // Always uses the independent REPORT_APIFY_TOKEN
        const client = new ApifyClient({ token: REPORT_APIFY_TOKEN });

        // ... rest of report generation logic remains identical
